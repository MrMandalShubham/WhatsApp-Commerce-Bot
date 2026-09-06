import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { assertTransition } from "@wcb/core";
import { createPaymentProvider } from "@wcb/payments";

import { env } from "../config/env";
import { AuditService } from "../common/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";
import {
  CancelOrderDto,
  CorrectLocationDto,
  RefundDto,
  ResendLinkDto,
} from "./dto/order-actions.dto";

/**
 * Operational actions on a single order. Separate from the read/list
 * controller purely to keep each file legible; the route prefix is the same.
 */
@Controller("orders")
export class OrderActionsController {
  private readonly payments = createPaymentProvider({
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Cancels an order and puts the held stock back.
   *
   * Cancelling without releasing reservations is how phantom stock-outs
   * appear: the units are gone from `available` but no order will ever
   * consume them.
   */
  @Post(":id/cancel")
  @Roles("OWNER", "MANAGER")
  async cancel(
    @Param("id") id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: AuthedRequest,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { reservations: { where: { releasedAt: null } }, delivery: true },
    });
    if (!order) throw new NotFoundException("order not found");

    try {
      assertTransition("order", order.orderStatus, "CANCELLED");
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    if (order.fulfillmentStatus === "OUT_FOR_DELIVERY") {
      throw new BadRequestException(
        "order is already with a rider - mark the delivery failed first",
      );
    }
    if (order.paymentStatus === "PAID" && !dto.acknowledgeRefundDue) {
      throw new BadRequestException(
        "this order is paid; set acknowledgeRefundDue to confirm a refund is owed",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const r of order.reservations) {
        await tx.inventory.update({
          where: { id: r.inventoryId },
          data: { reserved: { decrement: r.quantity } },
        });
      }
      await tx.inventoryReservation.updateMany({
        where: { orderId: id, releasedAt: null },
        data: { releasedAt: new Date() },
      });

      await tx.order.update({
        where: { id },
        data: {
          orderStatus: "CANCELLED",
          cancelledAt: new Date(),
          cancelReason: dto.reason,
          ...(order.paymentStatus === "PAID" ? { paymentStatus: "REFUND_PENDING" } : {}),
        },
      });

      await tx.orderStatusHistory.create({
        data: {
          orderId: id, field: "order_status", fromValue: order.orderStatus,
          toValue: "CANCELLED", actorType: "STAFF", actorId: req.staff?.sub,
          reason: dto.reason,
        },
      });

      if (order.paymentStatus === "PAID") {
        await tx.orderStatusHistory.create({
          data: {
            orderId: id, field: "payment_status", fromValue: "PAID",
            toValue: "REFUND_PENDING", actorType: "STAFF", actorId: req.staff?.sub,
            reason: "order cancelled after payment",
          },
        });
      }

      await tx.trackingLink.updateMany({
        where: { orderId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (order.delivery) {
        await tx.delivery.update({
          where: { id: order.delivery.id },
          data: { status: "CANCELLED" },
        });
      }
    });

    await this.audit.record({
      staff: req.staff,
      action: "order.cancelled",
      targetType: "order",
      targetId: id,
      before: { orderStatus: order.orderStatus, paymentStatus: order.paymentStatus },
      after: { orderStatus: "CANCELLED" },
      reason: dto.reason,
      ip: req.ip,
    });

    return {
      orderStatus: "CANCELLED",
      stockReleased: order.reservations.reduce((n, r) => n + r.quantity, 0),
      refundDue: order.paymentStatus === "PAID",
    };
  }

  /** Records a refund against a payment. Reconciliation stays manual for now. */
  @Post(":id/refund")
  @Roles("OWNER", "MANAGER")
  async refund(@Param("id") id: string, @Body() dto: RefundDto, @Req() req: AuthedRequest) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { payments: { where: { status: "PAID" }, orderBy: { attemptNo: "desc" } } },
    });
    if (!order) throw new NotFoundException("order not found");

    if (!["PAID", "REFUND_PENDING"].includes(order.paymentStatus)) {
      throw new BadRequestException(
        `cannot refund an order whose payment is ${order.paymentStatus}`,
      );
    }
    if (dto.amountMinor > order.totalMinor) {
      throw new BadRequestException("refund exceeds the order total");
    }

    const alreadyRefunded = await this.prisma.refund.aggregate({
      where: { orderId: id, status: { not: "failed" } },
      _sum: { amountMinor: true },
    });
    const total = (alreadyRefunded._sum.amountMinor ?? 0) + dto.amountMinor;
    if (total > order.totalMinor) {
      throw new BadRequestException(
        `refunds would total ${total} against an order of ${order.totalMinor}`,
      );
    }

    const isFull = total === order.totalMinor;

    const refund = await this.prisma.$transaction(async (tx) => {
      const r = await tx.refund.create({
        data: {
          orderId: id,
          paymentId: order.payments[0]?.id,
          amountMinor: dto.amountMinor,
          status: "pending",
          reason: dto.reason,
        },
      });

      const to = isFull ? "REFUNDED" : "REFUND_PENDING";
      if (order.paymentStatus !== to) {
        assertTransition("payment", order.paymentStatus, to);
        await tx.order.update({ where: { id }, data: { paymentStatus: to } });
        await tx.orderStatusHistory.create({
          data: {
            orderId: id, field: "payment_status", fromValue: order.paymentStatus,
            toValue: to, actorType: "STAFF", actorId: req.staff?.sub, reason: dto.reason,
          },
        });
      }
      return r;
    });

    await this.audit.record({
      staff: req.staff,
      action: "order.refunded",
      targetType: "order",
      targetId: id,
      after: { amountMinor: dto.amountMinor, cumulativeMinor: total },
      reason: dto.reason,
      ip: req.ip,
    });

    return { refundId: refund.id, amountMinor: dto.amountMinor, fullyRefunded: isFull };
  }

  /**
   * Re-issues a payment link as a NEW attempt. Earlier attempts are never
   * overwritten, so the payment history stays intact.
   */
  @Post(":id/send-payment-link")
  @Roles("OWNER", "MANAGER", "OPERATOR")
  async resendLink(
    @Param("id") id: string,
    @Body() dto: ResendLinkDto,
    @Req() req: AuthedRequest,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: { select: { waPhone: true, name: true } },
        payments: { orderBy: { attemptNo: "desc" }, take: 1 },
      },
    });
    if (!order) throw new NotFoundException("order not found");
    if (order.paymentStatus === "PAID") {
      throw new BadRequestException("order is already paid");
    }
    if (order.orderStatus === "CANCELLED") {
      throw new BadRequestException("order is cancelled");
    }

    const ttl = dto.expiresInMinutes ?? 30;
    const link = await this.payments.createLink({
      referenceId: order.orderNumber,
      amountMinor: order.totalMinor,
      currency: order.currency,
      description: `Order ${order.orderNumber}`,
      customerName: order.customer.name ?? undefined,
      customerPhone: order.customer.waPhone,
      expiresInMinutes: ttl,
    });

    const attemptNo = (order.payments[0]?.attemptNo ?? 0) + 1;

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          orderId: id,
          attemptNo,
          provider: "razorpay",
          providerLinkId: link.providerLinkId,
          status: "LINK_SENT",
          amountMinor: order.totalMinor,
          currency: order.currency,
          linkUrl: link.url,
          linkExpiresAt: link.expiresAt,
        },
      });
      if (order.paymentStatus !== "LINK_SENT") {
        assertTransition("payment", order.paymentStatus, "LINK_SENT");
        await tx.order.update({ where: { id }, data: { paymentStatus: "LINK_SENT" } });
        await tx.orderStatusHistory.create({
          data: {
            orderId: id, field: "payment_status", fromValue: order.paymentStatus,
            toValue: "LINK_SENT", actorType: "STAFF", actorId: req.staff?.sub,
            reason: `payment link re-issued (attempt ${attemptNo})`,
          },
        });
      }
    });

    await this.queue.enqueueOrderNotification(id, `PAYMENT_LINK_${attemptNo}`);

    await this.audit.record({
      staff: req.staff,
      action: "order.payment_link_reissued",
      targetType: "order",
      targetId: id,
      after: { attemptNo, url: link.url },
      ip: req.ip,
    });

    return { attemptNo, url: link.url, expiresAt: link.expiresAt };
  }

  /**
   * Staff correction of a mis-pinned delivery location.
   *
   * Keeps the PostGIS point in sync and re-checks serviceability, so a
   * correction cannot quietly move an order outside the delivery area.
   */
  @Patch(":id/delivery-location")
  @Roles("OWNER", "MANAGER", "OPERATOR")
  async correctLocation(
    @Param("id") id: string,
    @Body() dto: CorrectLocationDto,
    @Req() req: AuthedRequest,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { address: true },
    });
    if (!order?.address) throw new NotFoundException("order has no delivery address");
    if (order.fulfillmentStatus === "DELIVERED") {
      throw new BadRequestException("order is already delivered");
    }

    const before = {
      latitude: order.address.latitude,
      longitude: order.address.longitude,
      landmark: order.address.landmark,
    };

    await this.prisma.customerAddress.update({
      where: { id: order.address.id },
      data: {
        latitude: dto.latitude,
        longitude: dto.longitude,
        ...(dto.landmark !== undefined ? { landmark: dto.landmark } : {}),
        source: "STAFF_CORRECTED",
      },
    });
    await this.prisma.$executeRawUnsafe(
      `UPDATE customer_addresses
          SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        WHERE id = $3`,
      dto.longitude,
      dto.latitude,
      order.address.id,
    );

    const zone = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM service_areas
       WHERE "isActive" = true AND polygon IS NOT NULL
         AND ST_Contains(polygon::geometry,
                         ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326))
       LIMIT 1`;

    await this.audit.record({
      staff: req.staff,
      action: "order.location_corrected",
      targetType: "order",
      targetId: id,
      before,
      after: { latitude: dto.latitude, longitude: dto.longitude, landmark: dto.landmark },
      reason: dto.reason,
      ip: req.ip,
    });

    return {
      latitude: dto.latitude,
      longitude: dto.longitude,
      serviceable: zone.length > 0,
      areaName: zone[0]?.name ?? null,
    };
  }
}
