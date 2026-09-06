import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

@Controller("health")
@Public()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Liveness - is the process up. */
  @Get()
  live(): { status: string; uptime: number } {
    return { status: "ok", uptime: Math.round(process.uptime()) };
  }

  /** Readiness - can we actually serve traffic. */
  @Get("ready")
  async ready(): Promise<Record<string, unknown>> {
    const [db, redis, postgis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.queue.ping()),
      this.check(
        () => this.prisma.$queryRaw`SELECT extname FROM pg_extension WHERE extname = 'postgis'`,
      ),
    ]);
    const ok = db && redis && postgis;
    return { status: ok ? "ok" : "degraded", db, redis, postgis };
  }

  private async check(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }
}
