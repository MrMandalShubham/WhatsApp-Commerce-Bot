import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { assertTransition, etaMinutes, haversineMetres, summariseSettlement } from "@wcb/core";

import { AuditService } from "../common/audit.service";
import { PositionService } from "../common/position.service";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";
import { CompleteDeliveryDto, PingDto, SettleCashDto, StartTripDto } from "./dto/rider.dto";

const TRACKING_TTL_HOURS = 6;

@Controller("rider")
export class RiderController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly positions: PositionService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /** Resolves the rider record behind the authenticated staff user. */
  private async me(req: AuthedRequest) {
    const rider = await this.prisma.rider.findUnique({
      where: { staffUserId: req.staff?.sub },
    });
    if (!rider) throw new ForbiddenException("no rider profile for this account");
    if (!rider.isActive) throw new ForbiddenException("rider is inactive");
    return rider;
  }

  @Get("assignments")
  @Roles("RIDER", "OWNER", "MANAGER")
  async assignments(@Req() req: AuthedRequest) {
    const rider = await this.me(req);
    const rows = await this.prisma.delivery.findMany({
      where: { riderId: rider.id, status: { in: ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] } },
      include: {
        order: {
          include: {
            customer: { select: { name: true, waPhone: true } },
            address: true,
            items: { select: { titleSnapshot: true, quantity: true } },
          },
        },
        codCollection: true,
      },
      orderBy: [{ sequence: "asc" }, { assignedAt: "asc" }],
    });

    return rows.map((d) => ({
      deliveryId: d.id,
      status: d.status,
      order: {
        orderNumber: d.order.orderNumber,
        totalMinor: d.order.totalMinor,
        paymentMode: d.order.paymentMode,
        // The rider must know whether to collect cash, and exactly how much.
        collectCashMinor:
          d.order.paymentMode === "COD" && d.order.paymentStatus !== "PAID"
            ? (d.codCollection?.amountDueMinor ?? d.order.totalMinor)
            : 0,
        items: d.order.items,
      },
      customer: {
        name: d.order.customer.name,
        // Masked: the rider gets a call button in the app, not the raw number.
        phoneMasked: maskPhone(d.order.customer.waPhone),
      },
      address: d.order.address
        ? {
            line1: d.order.address.line1,
            landmark: d.order.address.landmark,
            latitude: d.order.address.latitude,
            longitude: d.order.address.longitude,
            mapsUrl:
              d.order.address.latitude != null && d.order.address.longitude != null
                ? `https://www.google.com/maps/dir/?api=1&destination=${d.order.address.latitude},${d.order.address.longitude}`
                : null,
          }
        : null,
    }));
  }

  /**
   * Starts the trip. This is the point a tracking link becomes live and the
   * customer is told the order is on its way.
   */
  @Post("assignments/:id/start")
  @Roles("RIDER", "OWNER", "MANAGER")
  async start(@Param("id") id: string, @Body() dto: StartTripDto, @Req() req: AuthedRequest) {
    const rider = await this.me(req);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!delivery || delivery.riderId !== rider.id) {
      throw new NotFoundException("assignment not found");
    }
    if (delivery.status === "DELIVERED") {
      throw new BadRequestException("delivery is already complete");
    }

    const token = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + TRACKING_TTL_HOURS * 3600_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.delivery.update({
        where: { id },
        data: { status: "OUT_FOR_DELIVERY", startedAt: new Date() },
      });

      assertTransition("fulfillment", delivery.order.fulfillmentStatus, "OUT_FOR_DELIVERY");
      await tx.order.update({
        where: { id: delivery.orderId },
        data: { fulfillmentStatus: "OUT_FOR_DELIVERY" },
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId: delivery.orderId,
          field: "fulfillment_status",
          fromValue: delivery.order.fulfillmentStatus,
          toValue: "OUT_FOR_DELIVERY",
          actorType: "RIDER",
          actorId: rider.id,
        },
      });

      await tx.trackingLink.create({
        data: { orderId: delivery.orderId, token, expiresAt },
      });
    });

    if (dto.latitude != null && dto.longitude != null) {
      await this.positions.set(rider.id, {
        lat: dto.latitude,
        lng: dto.longitude,
        at: new Date().toISOString(),
      });
    }

    await this.queue.enqueueOrderNotification(delivery.orderId, "OUT_FOR_DELIVERY");
    return { status: "OUT_FOR_DELIVERY", trackingToken: token, expiresAt };
  }

  /**
   * GPS ping. Hot position goes to Redis; only a sampled copy is persisted,
   * and those rows are purged after RIDER_PING_RETENTION_DAYS.
   */
  @Post("location")
  @Roles("RIDER", "OWNER", "MANAGER")
  async ping(@Body() dto: PingDto, @Req() req: AuthedRequest) {
    const rider = await this.me(req);
    const at = new Date();

    await this.positions.set(rider.id, {
      lat: dto.latitude,
      lng: dto.longitude,
      accuracyM: dto.accuracyM,
      at: at.toISOString(),
    });

    if (await this.positions.shouldPersist(rider.id)) {
      const row = await this.prisma.riderLocationPing.create({
        data: {
          riderId: rider.id,
          deliveryId: dto.deliveryId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracyM: dto.accuracyM,
          recordedAt: at,
        },
        select: { id: true },
      });
      await this.prisma.$executeRawUnsafe(
        `UPDATE rider_location_pings
            SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
          WHERE id = $3`,
        dto.longitude,
        dto.latitude,
        row.id,
      );
    }

    return { ok: true };
  }

  @Post("assignments/:id/complete")
  @Roles("RIDER", "OWNER", "MANAGER")
  async complete(
    @Param("id") id: string,
    @Body() dto: CompleteDeliveryDto,
    @Req() req: AuthedRequest,
  ) {
    const rider = await this.me(req);
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: { order: true, codCollection: true },
    });
    if (!delivery || delivery.riderId !== rider.id) {
      throw new NotFoundException("assignment not found");
    }
    if (delivery.status === "DELIVERED" || delivery.status === "FAILED") {
      throw new BadRequestException("delivery is already closed");
    }

    const isCod =
      delivery.order.paymentMode === "COD" && delivery.order.paymentStatus !== "PAID";

    if (dto.outcome === "DELIVERED" && isCod && dto.amountCollectedMinor == null) {
      throw new BadRequestException("amountCollectedMinor is required for a COD delivery");
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.outcome === "DELIVERED") {
        await tx.delivery.update({
          where: { id },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            podType: dto.podType ?? "NONE",
            podPhotoUrl: dto.podPhotoUrl,
            recipientName: dto.recipientName,
            podVerifiedAt: dto.podType && dto.podType !== "NONE" ? new Date() : null,
          },
        });

        assertTransition("fulfillment", delivery.order.fulfillmentStatus, "DELIVERED");
        await tx.order.update({
          where: { id: delivery.orderId },
          data: {
            fulfillmentStatus: "DELIVERED",
            // COD is only "paid" once the rider actually has the cash.
            ...(isCod ? { paymentStatus: "PAID" } : {}),
            ...(delivery.order.orderStatus === "CONFIRMED" ? { orderStatus: "COMPLETED" } : {}),
          },
        });
        await tx.orderStatusHistory.createMany({
          data: [
            {
              orderId: delivery.orderId, field: "fulfillment_status",
              fromValue: delivery.order.fulfillmentStatus, toValue: "DELIVERED",
              actorType: "RIDER", actorId: rider.id,
            },
            ...(isCod
              ? [{
                  orderId: delivery.orderId, field: "payment_status",
                  fromValue: delivery.order.paymentStatus, toValue: "PAID",
                  actorType: "RIDER" as const, actorId: rider.id,
                  reason: "cash collected on delivery",
                }]
              : []),
            ...(delivery.order.orderStatus === "CONFIRMED"
              ? [{
                  orderId: delivery.orderId, field: "order_status",
                  fromValue: "CONFIRMED", toValue: "COMPLETED",
                  actorType: "RIDER" as const, actorId: rider.id,
                }]
              : []),
          ],
        });

        if (isCod) {
          await tx.codCollection.upsert({
            where: { deliveryId: id },
            update: {
              amountCollectedMinor: dto.amountCollectedMinor ?? 0,
              collectedAt: new Date(),
              note: dto.note,
            },
            create: {
              deliveryId: id,
              orderId: delivery.orderId,
              amountDueMinor: delivery.order.totalMinor,
              amountCollectedMinor: dto.amountCollectedMinor ?? 0,
              collectedAt: new Date(),
              note: dto.note,
            },
          });
        }
      } else {
        await tx.delivery.update({
          where: { id },
          data: { status: "FAILED", failedAt: new Date(), failureReason: dto.note },
        });
        assertTransition("fulfillment", delivery.order.fulfillmentStatus, "FAILED_DELIVERY");
        await tx.order.update({
          where: { id: delivery.orderId },
          data: { fulfillmentStatus: "FAILED_DELIVERY" },
        });
        await tx.orderStatusHistory.create({
          data: {
            orderId: delivery.orderId, field: "fulfillment_status",
            fromValue: delivery.order.fulfillmentStatus, toValue: "FAILED_DELIVERY",
            actorType: "RIDER", actorId: rider.id, reason: dto.note,
          },
        });
      }

      // The tracking link dies with the trip - it must not stay live after
      // the order is closed.
      await tx.trackingLink.updateMany({
        where: { orderId: delivery.orderId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    await this.queue.enqueueOrderNotification(
      delivery.orderId,
      dto.outcome === "DELIVERED" ? "DELIVERED" : "FAILED_DELIVERY",
    );

    return { status: dto.outcome };
  }

  @Get("cash")
  @Roles("RIDER", "OWNER", "MANAGER")
  async cash(@Req() req: AuthedRequest) {
    const rider = await this.me(req);
    const open = await this.prisma.codCollection.findMany({
      where: { settlementId: null, collectedAt: { not: null }, delivery: { riderId: rider.id } },
      select: { amountDueMinor: true, amountCollectedMinor: true, orderId: true },
    });
    const summary = summariseSettlement(open);
    return {
      ...summary,
      ceilingMinor: rider.cashCeilingMinor,
      openCollections: open.length,
      overCeiling: summary.collectedMinor > rider.cashCeilingMinor,
    };
  }

  /** Rider hands cash to the shop; a staff member accepts and signs it off. */
  @Post("cash/settle")
  @Roles("OWNER", "MANAGER")
  async settle(@Body() dto: SettleCashDto, @Req() req: AuthedRequest) {
    const rider = await this.prisma.rider.findUnique({ where: { id: dto.riderId } });
    if (!rider) throw new NotFoundException("rider not found");

    const open = await this.prisma.codCollection.findMany({
      where: { settlementId: null, collectedAt: { not: null }, delivery: { riderId: rider.id } },
      select: { id: true, amountDueMinor: true, amountCollectedMinor: true },
    });
    if (!open.length) throw new BadRequestException("no outstanding collections for this rider");

    const summary = summariseSettlement(open);
    // Shortfall is measured against what the rider actually collected, not
    // what was owed by customers - those are two different problems.
    const shortfallMinor = Math.max(0, summary.collectedMinor - dto.receivedMinor);

    const settlement = await this.prisma.$transaction(async (tx) => {
      const s = await tx.riderCashSettlement.create({
        data: {
          riderId: rider.id,
          expectedMinor: summary.collectedMinor,
          receivedMinor: dto.receivedMinor,
          shortfallMinor,
          acceptedByStaffId: req.staff?.sub,
          note: dto.note,
        },
      });
      await tx.codCollection.updateMany({
        where: { id: { in: open.map((o) => o.id) } },
        data: { settlementId: s.id },
      });
      return s;
    });

    await this.audit.record({
      staff: req.staff,
      action: "rider.cash_settled",
      targetType: "rider",
      targetId: rider.id,
      after: {
        expectedMinor: summary.collectedMinor,
        receivedMinor: dto.receivedMinor,
        shortfallMinor,
      },
      reason: dto.note,
      ip: req.ip,
    });

    return settlement;
  }
}

function maskPhone(phone: string): string {
  return phone.length <= 4 ? "****" : `${"*".repeat(phone.length - 4)}${phone.slice(-4)}`;
}
