import { Controller, Get, Query } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

import { PrismaService } from "../prisma/prisma.service";
import { Roles } from "../auth/roles.decorator";

class RangeQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  days = 7;
}

/**
 * Operational counters for the dashboard. Deliberately a handful of cheap
 * aggregate queries rather than a reporting layer - the shop needs "what
 * happened today and what is stuck", not a warehouse.
 */
@Controller("reports")
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("overview")
  @Roles("OWNER", "MANAGER")
  async overview(@Query() q: RangeQuery) {
    const since = new Date(Date.now() - q.days * 24 * 3600_000);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      todayOrders,
      todayRevenue,
      periodOrders,
      periodRevenue,
      byFulfillment,
      byPayment,
      awaitingPayment,
      failedPayments,
      ridersOnTrip,
      unprocessedWebhooks,
      failedSends,
      lowStock,
    ] = await Promise.all([
      this.prisma.order.count({ where: { placedAt: { gte: startOfDay } } }),
      this.prisma.order.aggregate({
        where: { placedAt: { gte: startOfDay }, orderStatus: { not: "CANCELLED" } },
        _sum: { totalMinor: true },
      }),
      this.prisma.order.count({ where: { placedAt: { gte: since } } }),
      this.prisma.order.aggregate({
        where: { placedAt: { gte: since }, orderStatus: { not: "CANCELLED" } },
        _sum: { totalMinor: true },
      }),
      this.prisma.order.groupBy({
        by: ["fulfillmentStatus"],
        where: { placedAt: { gte: since } },
        _count: true,
      }),
      this.prisma.order.groupBy({
        by: ["paymentStatus"],
        where: { placedAt: { gte: since } },
        _count: true,
      }),
      this.prisma.order.count({
        where: { paymentStatus: { in: ["PENDING", "LINK_SENT"] }, orderStatus: { not: "CANCELLED" } },
      }),
      this.prisma.order.count({
        where: { paymentStatus: { in: ["FAILED", "EXPIRED"] }, orderStatus: { not: "CANCELLED" } },
      }),
      this.prisma.delivery.count({ where: { status: "OUT_FOR_DELIVERY" } }),
      // Anything sitting unprocessed for more than 5 minutes is stuck, not busy.
      this.prisma.webhookEvent.count({
        where: { processedAt: null, receivedAt: { lt: new Date(Date.now() - 300_000) } },
      }),
      this.prisma.whatsappMessage.count({
        where: { status: "FAILED", createdAt: { gte: since } },
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count
          FROM inventory i
         WHERE (i."onHand" - i.reserved) <= 5`,
    ]);

    return {
      periodDays: q.days,
      today: {
        orders: todayOrders,
        revenueMinor: todayRevenue._sum.totalMinor ?? 0,
      },
      period: {
        orders: periodOrders,
        revenueMinor: periodRevenue._sum.totalMinor ?? 0,
        averageOrderMinor: periodOrders
          ? Math.round((periodRevenue._sum.totalMinor ?? 0) / periodOrders)
          : 0,
      },
      fulfillment: Object.fromEntries(
        byFulfillment.map((r) => [r.fulfillmentStatus, r._count]),
      ),
      payment: Object.fromEntries(byPayment.map((r) => [r.paymentStatus, r._count])),
      // Everything below is a "needs a human" counter.
      attention: {
        awaitingPayment,
        failedPayments,
        ridersOnTrip,
        stuckWebhooks: unprocessedWebhooks,
        failedMessageSends: failedSends,
        lowStockProducts: Number(lowStock[0]?.count ?? 0),
      },
    };
  }

  /** Orders and revenue per day, for a simple chart. */
  @Get("daily")
  @Roles("OWNER", "MANAGER")
  async daily(@Query() q: RangeQuery) {
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; orders: bigint; revenue: bigint | null; cancelled: bigint }>
    >`
      SELECT date_trunc('day', "placedAt") AS day,
             count(*)::bigint AS orders,
             sum("totalMinor") FILTER (WHERE "orderStatus" <> 'CANCELLED')::bigint AS revenue,
             count(*) FILTER (WHERE "orderStatus" = 'CANCELLED')::bigint AS cancelled
        FROM orders
       WHERE "placedAt" >= now() - (${q.days}::int * INTERVAL '1 day')
       GROUP BY 1
       ORDER BY 1 DESC`;

    return rows.map((r) => ({
      day: r.day,
      orders: Number(r.orders),
      revenueMinor: Number(r.revenue ?? 0),
      cancelled: Number(r.cancelled),
    }));
  }

  /** Rider performance and outstanding cash, for the daily settlement run. */
  @Get("riders")
  @Roles("OWNER", "MANAGER")
  async riders(@Query() q: RangeQuery) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        delivered: bigint;
        failed: bigint;
        cash_outstanding: bigint | null;
        ceiling: number;
      }>
    >`
      SELECT r.id,
             r.name,
             count(*) FILTER (WHERE d.status = 'DELIVERED')::bigint AS delivered,
             count(*) FILTER (WHERE d.status = 'FAILED')::bigint    AS failed,
             COALESCE(SUM(cc."amountCollectedMinor")
                      FILTER (WHERE cc."settlementId" IS NULL), 0)::bigint AS cash_outstanding,
             r."cashCeilingMinor" AS ceiling
        FROM riders r
        LEFT JOIN deliveries d
               ON d."riderId" = r.id
              AND d."assignedAt" >= now() - (${q.days}::int * INTERVAL '1 day')
        LEFT JOIN cod_collections cc ON cc."deliveryId" = d.id
       WHERE r."isActive" = true
       GROUP BY r.id, r.name, r."cashCeilingMinor"
       ORDER BY delivered DESC`;

    return rows.map((r) => {
      const delivered = Number(r.delivered);
      const failed = Number(r.failed);
      const attempts = delivered + failed;
      return {
        id: r.id,
        name: r.name,
        delivered,
        failed,
        successRate: attempts ? Math.round((delivered / attempts) * 100) : null,
        cashOutstandingMinor: Number(r.cash_outstanding ?? 0),
        cashCeilingMinor: r.ceiling,
        overCeiling: Number(r.cash_outstanding ?? 0) > r.ceiling,
      };
    });
  }

  /** What is selling, so the shop knows what to restock. */
  @Get("products")
  @Roles("OWNER", "MANAGER")
  async products(@Query() q: RangeQuery) {
    const rows = await this.prisma.$queryRaw<
      Array<{ title: string; sku: string; units: bigint; revenue: bigint }>
    >`
      SELECT oi."titleSnapshot" AS title,
             oi."skuSnapshot"   AS sku,
             SUM(oi.quantity)::bigint       AS units,
             SUM(oi."lineTotalMinor")::bigint AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi."orderId"
       WHERE o."placedAt" >= now() - (${q.days}::int * INTERVAL '1 day')
         AND o."orderStatus" <> 'CANCELLED'
       GROUP BY 1, 2
       ORDER BY units DESC
       LIMIT 20`;

    return rows.map((r) => ({
      title: r.title,
      sku: r.sku,
      units: Number(r.units),
      revenueMinor: Number(r.revenue),
    }));
  }
}
