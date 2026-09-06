import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload } from "../auth/auth.service";

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every staff mutation is recorded with before/after. The plan requires a
   * reason on manual overrides; the caller passes it through.
   */
  async record(params: {
    staff?: JwtPayload;
    action: string;
    targetType: string;
    targetId?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
    ip?: string;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: params.staff ? "STAFF" : "SYSTEM",
        actorId: params.staff?.sub,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        before: (params.before ?? undefined) as object | undefined,
        after: (params.after ?? undefined) as object | undefined,
        reason: params.reason,
        ip: params.ip,
      },
    });
  }
}
