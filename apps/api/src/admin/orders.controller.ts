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
import {
  assertTransition,
  canCarryCod,
  displayStatus,
  type FulfillmentStatus,
  type OrderStatus,
  type PaymentStatus,
} from "@wcb/core";

import { AuditService } from "../common/audit.service";
import { PageQuery, cursorArgs, toPage } from "../common/pagination";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";
import { AssignRiderDto, ChangeStatusDto, OrderQuery } from "./dto/order.dto";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  async list(@Query() q: OrderQuery) {
    const rows = await this.prisma.order.findMany({
      where: {
        ...(q.status ? { orderStatus: q.status } : {}),
        ...(q.fulfillment ? { fulfillmentStatus: q.fulfillment } : {}),
        ...(q.payment ? { paymentStatus: q.payment } : {}),
        ...(q.phone ? { customer: { waPhone: q.phone } } : {}),
      },
      include: {
        customer: { select: { waPhone: true, name: true } },
        delivery: { include: { rider: { select: { id: true, name: true } } } },
        _count: { select: { items: true } },
      },
      orderBy: { id: "desc" },
      take: q.limit + 1,
      ...cursorArgs(q.cursor),
    });

    const page = toPage(rows, q.limit);
    return {
      ...page,
      data: page.data.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customer: o.customer,
        paymentMode: o.paymentMode,
        paymentStatus: o.paymentStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        orderStatus: o.orderStatus,
        // Derived, never stored - see the plan's three-status rule.
        displayStatus: displayStatus(
          o.paymentStatus as PaymentStatus,
          o.fulfillmentStatus as FulfillmentStatus,
          o.orderStatus as OrderStatus,
        ),
        totalMinor: o.totalMinor,
        itemCount: o._count.items,
        rider: o.delivery?.rider ?? null,
        placedAt: o.placedAt,
      })),
    };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
      include: {
        customer: { select: { waPhone: true, name: true } },
        address: true,
        items: true,
        payments: { orderBy: { attemptNo: "desc" } },
        refunds: true,
        delivery: { include: { rider: { select: { id: true, name: true, phone: true } } } },
        codCollection: true,
        statusHistory: { orderBy: { occurredAt: "asc" } },
      },
    });
    if (!order) throw new NotFoundException("order not found");

    return {
      ...order,
      displayStatus: displayStatus(
        order.paymentStatus as PaymentStatus,
        order.fulfillmentStatus as FulfillmentStatus,
        order.orderStatus as OrderStatus,
      ),
    };
  }

  /**
   * Manual override. The transition is still guarded - staff can correct a
   * status, but cannot walk an order into a state the machine forbids.
   */
  @Post(":id/change-status")
  @Roles("OWNER", "MANAGER", "OPERATOR")
  async changeStatus(
    @Param("id") id: string,
    @Body() dto: ChangeStatusDto,
    @Req() req: AuthedRequest,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("order not found");

    const before = {
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      orderStatus: order.orderStatus,
    };

    const from =
      dto.field === "payment" ? order.paymentStatus
      : dto.field === "fulfillment" ? order.fulfillmentStatus
      : order.orderStatus;

    try {
      assertTransition(dto.field, from, dto.to);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const column =
      dto.field === "payment" ? "paymentStatus"
      : dto.field === "fulfillment" ? "fulfillmentStatus"
      : "orderStatus";

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id },
        data: { [column]: dto.to },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          field: `${dto.field}_status`,
          fromValue: from,
          toValue: dto.to,
          actorType: "STAFF",
          actorId: req.staff?.sub,
          reason: dto.reason,
        },
      });
      return updated;
    });

    await this.audit.record({
      staff: req.staff,
      action: "order.status_changed",
      targetType: "order",
      targetId: id,
      before,
      after: { [column]: dto.to },
      reason: dto.reason,
      ip: req.ip,
    });

    await this.queue.enqueueOrderNotification(id, dto.to);
    return { id, [column]: dto.to };
  }

  /**
   * Assigns a rider. For a COD order the rider's undeposited cash is checked
   * first - with own riders there is no courier float, so an unchecked
   * assignment is how cash goes missing.
   */
  @Post(":id/assign-rider")
  @Roles("OWNER", "MANAGER", "OPERATOR")
  async assignRider(
    @Param("id") id: string,
    @Body() dto: AssignRiderDto,
    @Req() req: AuthedRequest,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { delivery: true },
    });
    if (!order) throw new NotFoundException("order not found");
    if (order.orderStatus === "CANCELLED") {
      throw new BadRequestException("cannot assign a rider to a cancelled order");
    }

    const rider = await this.prisma.rider.findUnique({ where: { id: dto.riderId } });
    if (!rider?.isActive) throw new BadRequestException("rider not found or inactive");

    if (order.paymentMode === "COD" && order.paymentStatus !== "PAID") {
      const held = await this.prisma.codCollection.aggregate({
        where: { settlementId: null, collectedAt: { not: null }, delivery: { riderId: rider.id } },
        _sum: { amountCollectedMinor: true },
      });
      const check = canCarryCod(
        {
          outstandingMinor: held._sum.amountCollectedMinor ?? 0,
          ceilingMinor: rider.cashCeilingMinor,
        },
        order.totalMinor,
      );
      if (!check.allowed) throw new BadRequestException(check.message);
    }

    const delivery = await this.prisma.$transaction(async (tx) => {
      const d = await tx.delivery.upsert({
        where: { orderId: id },
        update: { riderId: rider.id, status: "ASSIGNED", assignedAt: new Date() },
        create: { orderId: id, riderId: rider.id, status: "ASSIGNED" },
      });

      // COD amount due is recorded at assignment, so the cash ledger exists
      // before the rider ever leaves the shop.
      if (order.paymentMode === "COD" && order.paymentStatus !== "PAID") {
        await tx.codCollection.upsert({
          where: { deliveryId: d.id },
          update: { amountDueMinor: order.totalMinor },
          create: { deliveryId: d.id, orderId: id, amountDueMinor: order.totalMinor },
        });
      }

      if (order.fulfillmentStatus === "PACKED") {
        await tx.order.update({ where: { id }, data: { fulfillmentStatus: "ASSIGNED" } });
        await tx.orderStatusHistory.create({
          data: {
            orderId: id, field: "fulfillment_status", fromValue: "PACKED",
            toValue: "ASSIGNED", actorType: "STAFF", actorId: req.staff?.sub,
            reason: `assigned to ${rider.name}`,
          },
        });
      }
      return d;
    });

    await this.audit.record({
      staff: req.staff,
      action: "order.rider_assigned",
      targetType: "order",
      targetId: id,
      after: { riderId: rider.id, riderName: rider.name },
      ip: req.ip,
    });

    return { deliveryId: delivery.id, riderId: rider.id, status: delivery.status };
  }

  @Get("riders/cash")
  @Roles("OWNER", "MANAGER")
  async riderCash() {
    const riders = await this.prisma.rider.findMany({
      where: { isActive: true },
      select: { id: true, name: true, phone: true, cashCeilingMinor: true },
    });

    const held = await this.prisma.codCollection.groupBy({
      by: ["deliveryId"],
      where: { settlementId: null, collectedAt: { not: null } },
      _sum: { amountCollectedMinor: true },
    });
    const deliveries = await this.prisma.delivery.findMany({
      where: { id: { in: held.map((h) => h.deliveryId) } },
      select: { id: true, riderId: true },
    });

    const byRider = new Map<string, number>();
    for (const h of held) {
      const riderId = deliveries.find((d) => d.id === h.deliveryId)?.riderId;
      if (!riderId) continue;
      byRider.set(riderId, (byRider.get(riderId) ?? 0) + (h._sum.amountCollectedMinor ?? 0));
    }

    return riders.map((r) => ({
      ...r,
      outstandingMinor: byRider.get(r.id) ?? 0,
      overCeiling: (byRider.get(r.id) ?? 0) > r.cashCeilingMinor,
    }));
  }
}
