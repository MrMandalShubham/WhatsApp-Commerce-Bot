import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { PrismaClient } from "@prisma/client";

import { createProvider } from "@wcb/whatsapp";
import { createPaymentProvider } from "@wcb/payments";

import { QUEUES, JOBS } from "./constants";
import { processInboundWhatsapp } from "./processors/inbound-whatsapp";
import { runMaintenance } from "./processors/maintenance";
import { processPaymentEvent } from "./processors/payment";
import { processOrderNotification } from "./processors/notifications";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://redis:6379", {
  // Railway's private network is IPv6-only and ioredis defaults to IPv4, so
  // without family 0 the hostname never resolves and the worker sits silently
  // retrying forever. Family 0 works on both Railway and local Docker.
  family: 0,
  maxRetriesPerRequest: null, // required by BullMQ
  retryStrategy: (attempt) => (attempt > 20 ? null : Math.min(attempt * 200, 3000)),
});
connection.on("error", (e) =>
  log("redis.error", { error: (e as Error).message }),
);

// Falls back to a logging stub when no access token is set, so the whole
// conversation can be exercised before the Meta account exists.
const whatsapp = createProvider({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  apiVersion: process.env.WHATSAPP_API_VERSION,
});

const payments = createPaymentProvider({
  keyId: process.env.RAZORPAY_KEY_ID,
  keySecret: process.env.RAZORPAY_KEY_SECRET,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
});

const log = (msg: string, extra?: unknown): void =>
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), msg, ...(extra as object) }),
  );

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // Inbound WhatsApp events. The API stores the raw payload and enqueues the
  // event id; all the slow work happens here so the webhook can ack fast.
  // -----------------------------------------------------------------------
  const inbound = new Worker(
    QUEUES.INBOUND_WHATSAPP,
    async (job: Job) =>
      processInboundWhatsapp(prisma, whatsapp, payments, job.data.webhookEventId),
    { connection, concurrency: 10 },
  );

  // -----------------------------------------------------------------------
  // Outbound sends. Placeholder until the WhatsAppProvider lands in Phase 2 -
  // the queue and retry semantics are what matter now.
  // -----------------------------------------------------------------------
  const outbound = new Worker(
    QUEUES.OUTBOUND_WHATSAPP,
    async (job: Job) => {
      log("outbound.send.stub", { jobId: job.id, name: job.name });
    },
    { connection, concurrency: 5, limiter: { max: 20, duration: 1000 } },
  );

  // -----------------------------------------------------------------------
  // Maintenance. These are not optional housekeeping - the plan's data rules
  // depend on them running: reservations expire, PII is purged on schedule,
  // and tracking links die after delivery.
  // -----------------------------------------------------------------------
  // Gateway callbacks. Kept off the inbound queue so a payment backlog can
  // never delay a customer's conversation, and vice versa.
  const paymentWorker = new Worker(
    QUEUES.PAYMENTS,
    async (job: Job) =>
      processPaymentEvent(prisma, payments, whatsapp, job.data.webhookEventId),
    { connection, concurrency: 5 },
  );

  // Fulfilment status updates to the customer. Rate-limited because these
  // fan out per order and each one is a billable template outside the window.
  const notifications = new Worker(
    QUEUES.NOTIFICATIONS,
    async (job: Job) =>
      processOrderNotification(
        prisma, whatsapp, connection, job.data.orderId, job.data.event,
      ),
    { connection, concurrency: 5, limiter: { max: 20, duration: 1000 } },
  );

  const maintenance = new Worker(
    QUEUES.MAINTENANCE,
    async (job: Job) => runMaintenance(prisma, job.name),
    { connection, concurrency: 1 },
  );

  const maintenanceQueue = new Queue(QUEUES.MAINTENANCE, { connection });
  await scheduleRepeatables(maintenanceQueue);

  for (const [name, w] of [
    ["inbound", inbound],
    ["outbound", outbound],
    ["payments", paymentWorker],
    ["notifications", notifications],
    ["maintenance", maintenance],
  ] as const) {
    w.on("failed", (job, err) =>
      log("job.failed", {
        queue: name,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        error: err.message,
      }),
    );
    w.on("completed", (job) =>
      log("job.completed", { queue: name, jobId: job.id, name: job.name }),
    );
  }

  log("worker.started", {
    queues: Object.values(QUEUES),
    redis: (process.env.REDIS_URL ?? "").replace(/:[^:@]*@/, ":***@"),
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("worker.shutdown", { signal });
    await Promise.allSettled([
      inbound.close(),
      outbound.close(),
      paymentWorker.close(),
      notifications.close(),
      maintenance.close(),
      maintenanceQueue.close(),
    ]);
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * Repeatable jobs are idempotent to register - BullMQ dedupes on the repeat
 * key, so restarting the worker does not stack duplicates.
 */
async function scheduleRepeatables(queue: Queue): Promise<void> {
  const every = (ms: number) => ({
    repeat: { every: ms },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });

  await queue.add(JOBS.RELEASE_EXPIRED_RESERVATIONS, {}, every(60_000));
  await queue.add(JOBS.EXPIRE_ABANDONED_CARTS, {}, every(15 * 60_000));
  await queue.add(JOBS.REVOKE_STALE_TRACKING_LINKS, {}, every(10 * 60_000));
  await queue.add(JOBS.PURGE_RIDER_PINGS, {}, every(24 * 3600_000));
  await queue.add(JOBS.PURGE_WEBHOOK_EVENTS, {}, every(24 * 3600_000));
}

main().catch((err) => {
  log("worker.fatal", { error: (err as Error).message });
  process.exit(1);
});
