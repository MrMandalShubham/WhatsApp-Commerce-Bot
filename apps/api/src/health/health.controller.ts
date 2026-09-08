import { Controller, Get, HttpCode, Res } from "@nestjs/common";
import type { Response } from "express";

import { Public } from "../auth/public.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

/** A readiness probe must always answer. Nothing here may outlive this. */
const CHECK_TIMEOUT_MS = 4000;

@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Liveness — is the process up. Touches nothing external. */
  @Get()
  live(): { status: string; uptime: number } {
    return { status: "ok", uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness — can we actually serve traffic.
   *
   * Returns 503 when degraded so uptime monitors and Railway see a failure
   * rather than a 200 that happens to contain `false`.
   */
  @Get("ready")
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    const [db, redis, postgis] = await Promise.all([
      this.check("db", () => this.prisma.$queryRaw`SELECT 1`),
      this.check("redis", () => this.queue.ping()),
      this.check(
        "postgis",
        () => this.prisma.$queryRaw`SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
      ),
    ]);

    const ok = db && redis && postgis;
    if (!ok) res.status(503);
    return { status: ok ? "ok" : "degraded", db, redis, postgis };
  }

  /**
   * Every check is bounded.
   *
   * Redis in particular cannot be left unbounded: the BullMQ clients are
   * created with `maxRetriesPerRequest: null`, which BullMQ requires, and
   * that makes a command against an unreachable server retry forever instead
   * of rejecting. Without this race the whole endpoint hangs and the probe
   * times out with no diagnosis — which is strictly worse than reporting the
   * dependency as down.
   */
  private async check(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} check timed out after ${CHECK_TIMEOUT_MS}ms`)),
            CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
