import type { PrismaClient } from "@prisma/client";
import { JOBS } from "../constants";

const days = (n: number): Date => new Date(Date.now() - n * 24 * 3600_000);

/**
 * The data rules in the plan are only real if these run. Each one is written
 * to be safely re-runnable.
 */
export async function runMaintenance(
  prisma: PrismaClient,
  job: string,
): Promise<void> {
  switch (job) {
    // Stock held by an abandoned checkout must go back on the shelf.
    case JOBS.RELEASE_EXPIRED_RESERVATIONS: {
      const expired = await prisma.inventoryReservation.findMany({
        where: { releasedAt: null, expiresAt: { lt: new Date() } },
        select: { id: true, inventoryId: true, quantity: true },
        take: 500,
      });
      if (!expired.length) return;

      await prisma.$transaction([
        ...expired.map((r) =>
          prisma.inventory.update({
            where: { id: r.inventoryId },
            data: { reserved: { decrement: r.quantity } },
          }),
        ),
        prisma.inventoryReservation.updateMany({
          where: { id: { in: expired.map((r) => r.id) } },
          data: { releasedAt: new Date() },
        }),
      ]);
      log(JOBS.RELEASE_EXPIRED_RESERVATIONS, { released: expired.length });
      return;
    }

    case JOBS.EXPIRE_ABANDONED_CARTS: {
      const hours = Number(process.env.CART_ABANDON_HOURS ?? 24);
      const { count } = await prisma.cart.updateMany({
        where: {
          status: "ACTIVE",
          updatedAt: { lt: new Date(Date.now() - hours * 3600_000) },
        },
        data: { status: "ABANDONED" },
      });
      log(JOBS.EXPIRE_ABANDONED_CARTS, { abandoned: count });
      return;
    }

    // A tracking link must not stay live after the order is done.
    case JOBS.REVOKE_STALE_TRACKING_LINKS: {
      const { count } = await prisma.trackingLink.updateMany({
        where: {
          revokedAt: null,
          OR: [
            { expiresAt: { lt: new Date() } },
            { order: { fulfillmentStatus: { in: ["DELIVERED", "RETURNED"] } } },
          ],
        },
        data: { revokedAt: new Date() },
      });
      log(JOBS.REVOKE_STALE_TRACKING_LINKS, { revoked: count });
      return;
    }

    // Location is sensitive personal data - the trail is operational, not a
    // business record, so it is purged on a fixed schedule.
    case JOBS.PURGE_RIDER_PINGS: {
      const retention = Number(process.env.RIDER_PING_RETENTION_DAYS ?? 30);
      const { count } = await prisma.riderLocationPing.deleteMany({
        where: { recordedAt: { lt: days(retention) } },
      });
      log(JOBS.PURGE_RIDER_PINGS, { deleted: count, retentionDays: retention });
      return;
    }

    case JOBS.PURGE_WEBHOOK_EVENTS: {
      const retention = Number(process.env.WEBHOOK_EVENT_RETENTION_DAYS ?? 90);
      const { count } = await prisma.webhookEvent.deleteMany({
        where: {
          receivedAt: { lt: days(retention) },
          processedAt: { not: null },
        },
      });
      log(JOBS.PURGE_WEBHOOK_EVENTS, { deleted: count, retentionDays: retention });
      return;
    }

    default:
      log("maintenance.unknown", { job });
  }
}

function log(msg: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}
