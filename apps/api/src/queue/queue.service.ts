import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { env } from "../config/env";
import { redisOptions } from "../common/redis.options";
import { DEFAULT_JOB_OPTS, JOBS, QUEUES } from "./queue.constants";

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection!: IORedis;
  private inbound!: Queue;
  private outbound!: Queue;
  private payments!: Queue;
  private notifications!: Queue;

  onModuleInit(): void {
    this.connection = new IORedis(env.REDIS_URL, redisOptions);
    this.connection.on("error", (e) =>
      this.logger.error(`Redis connection error: ${e.message}`),
    );
    this.inbound = new Queue(QUEUES.INBOUND_WHATSAPP, {
      connection: this.connection,
    });
    this.outbound = new Queue(QUEUES.OUTBOUND_WHATSAPP, {
      connection: this.connection,
    });
    this.payments = new Queue(QUEUES.PAYMENTS, { connection: this.connection });
    this.notifications = new Queue(QUEUES.NOTIFICATIONS, { connection: this.connection });
    this.logger.log("Queues connected");
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.inbound?.close(), this.outbound?.close(),
      this.payments?.close(), this.notifications?.close(),
    ]);
    await this.connection?.quit();
  }

  async ping(): Promise<string> {
    return this.connection.ping();
  }

  /**
   * jobId is the webhook event id, so a Meta retry that slips past the
   * database check still collapses to a single job.
   */
  async enqueueInboundWhatsapp(
    webhookEventId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    await this.inbound.add(
      JOBS.PROCESS_INBOUND,
      { webhookEventId },
      {
        ...DEFAULT_JOB_OPTS,
        // A replay needs a fresh id, otherwise the dedup that protects
        // production traffic silently swallows the recovery attempt.
        jobId: opts.force
          ? `inbound-${webhookEventId}-replay-${Date.now()}`
          : `inbound-${webhookEventId}`,
      },
    );
  }

  /** jobId is the event id, so a provider retry collapses to one job. */
  async enqueuePaymentEvent(
    webhookEventId: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    await this.payments.add(
      JOBS.PROCESS_PAYMENT,
      { webhookEventId },
      {
        ...DEFAULT_JOB_OPTS,
        jobId: opts.force
          ? `payment-${webhookEventId}-replay-${Date.now()}`
          : `payment-${webhookEventId}`,
      },
    );
  }

  /**
   * Status-change notification. Keyed on order + event so a double status
   * write cannot send the customer two identical messages.
   */
  async enqueueOrderNotification(
    orderId: string,
    event: string,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    await this.notifications.add(
      JOBS.ORDER_NOTIFICATION,
      { orderId, event },
      {
        ...DEFAULT_JOB_OPTS,
        jobId: opts.force
          ? `notify-${orderId}-${event}-resend-${Date.now()}`
          : `notify-${orderId}-${event}`,
      },
    );
  }

  /**
   * Queue depths plus the failed set, which is our dead-letter queue - jobs
   * land there once retries are exhausted and stay for an operator to see.
   */
  async getCounts(): Promise<
    Array<{ queue: string; waiting: number; active: number; completed: number; failed: number; delayed: number }>
  > {
    const queues: Array<[string, Queue]> = [
      [QUEUES.INBOUND_WHATSAPP, this.inbound],
      [QUEUES.OUTBOUND_WHATSAPP, this.outbound],
      [QUEUES.PAYMENTS, this.payments],
      [QUEUES.NOTIFICATIONS, this.notifications],
    ];
    return Promise.all(
      queues.map(async ([name, q]) => {
        const c = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
        return {
          queue: name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          delayed: c.delayed ?? 0,
        };
      }),
    );
  }

  async enqueueOutboundMessage(payload: Record<string, unknown>): Promise<void> {
    await this.outbound.add(JOBS.SEND_MESSAGE, payload, DEFAULT_JOB_OPTS);
  }
}
