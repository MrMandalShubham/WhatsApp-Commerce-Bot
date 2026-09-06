import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";

import { env } from "../config/env";

export interface RiderPosition {
  lat: number;
  lng: number;
  accuracyM?: number;
  at: string; // ISO
}

/**
 * Hot rider positions live in Redis, not Postgres.
 *
 * A rider pings every 10-15 seconds for the length of a trip; writing every
 * one of those to the database would be pure write load for data we only ever
 * read as "where are they right now". The durable trail is a sampled copy.
 */
@Injectable()
export class PositionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PositionService.name);
  private redis!: IORedis;

  /** Long enough to survive a tunnel, short enough not to show a ghost. */
  private readonly TTL_SECONDS = 600;

  onModuleInit(): void {
    this.redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  private key(riderId: string): string {
    return `rider:pos:${riderId}`;
  }

  async set(riderId: string, pos: RiderPosition): Promise<void> {
    await this.redis.set(this.key(riderId), JSON.stringify(pos), "EX", this.TTL_SECONDS);
  }

  async get(riderId: string): Promise<RiderPosition | null> {
    const raw = await this.redis.get(this.key(riderId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RiderPosition;
    } catch {
      this.logger.warn(`corrupt position payload for rider ${riderId}`);
      return null;
    }
  }

  /**
   * True roughly once per interval, used to decide whether this ping also
   * gets a durable row. Keyed per rider so two riders do not sample together.
   */
  async shouldPersist(riderId: string, everySeconds = 60): Promise<boolean> {
    const key = `rider:sample:${riderId}`;
    const ok = await this.redis.set(key, "1", "EX", everySeconds, "NX");
    return ok === "OK";
  }
}
