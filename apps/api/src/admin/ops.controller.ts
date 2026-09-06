import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from "class-validator";

import { AuditService } from "../common/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";

class EventQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit = 50;
  @IsOptional() @IsIn(["stuck", "failed", "all"]) state: "stuck" | "failed" | "all" = "stuck";
}

class ResendDto {
  @IsString() orderId!: string;
  @IsString() @Length(2, 40) event!: string;
  @IsOptional() @IsString() @Length(3, 300) reason?: string;
}

/**
 * Support and recovery tooling.
 *
 * The plan requires a dead-letter path with an admin-visible replay: raw
 * events are stored precisely so a bad deploy or a provider outage can be
 * recovered from without hand-editing the database.
 */
@Controller("ops")
export class OpsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /** Queue depths and dead-letter counts. */
  @Get("queues")
  @Roles("OWNER", "MANAGER")
  async queues() {
    return this.queue.getCounts();
  }

  /** Webhook events that never completed, newest first. */
  @Get("webhooks")
  @Roles("OWNER", "MANAGER")
  async webhooks(@Query() q: EventQuery) {
    const where =
      q.state === "stuck"
        ? { processedAt: null, receivedAt: { lt: new Date(Date.now() - 300_000) } }
        : q.state === "failed"
          ? { error: { not: null } }
          : {};

    const rows = await this.prisma.webhookEvent.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: q.limit,
      select: {
        id: true,
        provider: true,
        providerEventId: true,
        signatureValid: true,
        receivedAt: true,
        processedAt: true,
        attempts: true,
        error: true,
      },
    });
    return { count: rows.length, data: rows };
  }

  /**
   * Re-runs a stored event through its processor.
   *
   * Clearing processedAt first is what makes this a replay rather than a
   * no-op: the processors all short-circuit on an already-processed event.
   */
  @Post("webhooks/:id/replay")
  @Roles("OWNER", "MANAGER")
  async replay(@Param("id") id: string, @Req() req: AuthedRequest) {
    const event = await this.prisma.webhookEvent.findUnique({ where: { id } });
    if (!event) throw new NotFoundException("webhook event not found");
    if (!event.signatureValid) {
      // An unverified payload was never trusted on the way in; replaying it
      // would be a way to smuggle one past the signature check.
      throw new BadRequestException("refusing to replay an unverified event");
    }

    await this.prisma.webhookEvent.update({
      where: { id },
      data: { processedAt: null, error: null },
    });

    if (event.provider === "WHATSAPP") {
      await this.queue.enqueueInboundWhatsapp(id, { force: true });
    } else {
      await this.queue.enqueuePaymentEvent(id, { force: true });
    }

    await this.audit.record({
      staff: req.staff,
      action: "webhook.replayed",
      targetType: "webhook_event",
      targetId: id,
      before: { processedAt: event.processedAt, attempts: event.attempts },
      ip: req.ip,
    });

    return { replayed: true, provider: event.provider };
  }

  /** Outbound sends that failed, so staff can see what the customer missed. */
  @Get("messages/failed")
  @Roles("OWNER", "MANAGER")
  async failedMessages(@Query() q: EventQuery) {
    const rows = await this.prisma.whatsappMessage.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { customer: { select: { waPhone: true } } },
    });
    return rows.map((m) => ({
      id: m.id,
      phone: m.customer?.waPhone ?? null,
      type: m.type,
      templateName: m.templateName,
      errorCode: m.errorCode,
      errorMessage: m.errorMessage,
      createdAt: m.createdAt,
    }));
  }

  /** Re-queue a status notification the customer never received. */
  @Post("notifications/resend")
  @Roles("OWNER", "MANAGER")
  async resend(@Body() dto: ResendDto, @Req() req: AuthedRequest) {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true, orderNumber: true },
    });
    if (!order) throw new NotFoundException("order not found");

    // force bypasses the notify-<order>-<event> dedup, which is exactly the
    // thing standing between the customer and a second copy of the message.
    await this.queue.enqueueOrderNotification(order.id, dto.event, { force: true });

    await this.audit.record({
      staff: req.staff,
      action: "notification.resent",
      targetType: "order",
      targetId: order.id,
      after: { event: dto.event },
      reason: dto.reason,
      ip: req.ip,
    });

    return { queued: true, orderNumber: order.orderNumber, event: dto.event };
  }

  /** Recent staff actions - the audit log, readable. */
  @Get("audit")
  @Roles("OWNER", "MANAGER")
  async auditLog(@Query() q: EventQuery) {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { occurredAt: "desc" },
      take: q.limit,
    });
    const staffIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))] as string[];
    const staff = await this.prisma.staffUser.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, email: true },
    });
    const byId = new Map(staff.map((s) => [s.id, s.email]));

    return rows.map((r) => ({
      occurredAt: r.occurredAt,
      actor: r.actorId ? (byId.get(r.actorId) ?? r.actorId) : r.actorType,
      action: r.action,
      target: `${r.targetType}:${r.targetId ?? "-"}`,
      reason: r.reason,
    }));
  }
}
