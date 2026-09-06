import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { randomInt } from "node:crypto";

import { AuditService } from "../common/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { Roles } from "../auth/roles.decorator";
import { hashPassword } from "../auth/password";
import type { AuthedRequest } from "../auth/jwt.guard";
import { CreateRiderDto, ResetRiderPasswordDto, UpdateRiderDto } from "./dto/rider-admin.dto";

/** Readable but not guessable — a rider types this on a phone keypad. */
function generatePassword(): string {
  const words = [
    "delivery", "morning", "bicycle", "market", "orange", "temple",
    "garden", "railway", "monsoon", "lantern", "copper", "harbour",
  ];
  const pick = () => words[randomInt(words.length)];
  return `${pick()}-${pick()}-${randomInt(1000, 9999)}`;
}

/**
 * Rider accounts.
 *
 * A rider is two rows: a `staff_users` record with the RIDER role (that is
 * what they sign in with) and a `riders` record holding the operational
 * detail — phone, vehicle, cash ceiling. They are created and retired
 * together, so neither can be left orphaned.
 */
@Controller("riders")
export class RidersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles("OWNER", "MANAGER")
  async list() {
    const riders = await this.prisma.rider.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        staffUser: { select: { email: true, isActive: true, lastLoginAt: true } },
        _count: { select: { deliveries: true } },
      },
    });

    // Undeposited cash, per rider, in one grouped query.
    const held = await this.prisma.codCollection.findMany({
      where: { settlementId: null, collectedAt: { not: null } },
      select: { amountCollectedMinor: true, delivery: { select: { riderId: true } } },
    });
    const cash = new Map<string, number>();
    for (const c of held) {
      const id = c.delivery?.riderId;
      if (!id) continue;
      cash.set(id, (cash.get(id) ?? 0) + c.amountCollectedMinor);
    }

    const openStops = await this.prisma.delivery.groupBy({
      by: ["riderId"],
      where: { status: { in: ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] } },
      _count: true,
    });
    const open = new Map(openStops.map((o) => [o.riderId ?? "", o._count]));

    return riders.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.staffUser?.email ?? null,
      vehicleType: r.vehicleType,
      isActive: r.isActive,
      canSignIn: Boolean(r.staffUser?.isActive),
      lastLoginAt: r.staffUser?.lastLoginAt ?? null,
      cashCeilingMinor: r.cashCeilingMinor,
      cashOutstandingMinor: cash.get(r.id) ?? 0,
      overCeiling: (cash.get(r.id) ?? 0) > r.cashCeilingMinor,
      openStops: open.get(r.id) ?? 0,
      totalDeliveries: r._count.deliveries,
    }));
  }

  @Post()
  @Roles("OWNER", "MANAGER")
  async create(@Body() dto: CreateRiderDto, @Req() req: AuthedRequest) {
    const email = dto.email.toLowerCase().trim();
    const phone = normalisePhone(dto.phone);

    if (await this.prisma.staffUser.findUnique({ where: { email } })) {
      throw new BadRequestException(`${email} is already used by another account`);
    }
    if (await this.prisma.rider.findUnique({ where: { phone } })) {
      throw new BadRequestException(`${phone} is already registered to another rider`);
    }

    // Generated unless staff chose one, and returned exactly once - there is
    // no way to read it back afterwards.
    const password = dto.password?.trim() || generatePassword();
    if (password.length < 8) {
      throw new BadRequestException("password must be at least 8 characters");
    }

    const rider = await this.prisma.$transaction(async (tx) => {
      const staff = await tx.staffUser.create({
        data: {
          email,
          name: dto.name.trim(),
          passwordHash: await hashPassword(password),
          role: "RIDER",
        },
      });
      return tx.rider.create({
        data: {
          name: dto.name.trim(),
          phone,
          vehicleType: dto.vehicleType?.trim() || null,
          staffUserId: staff.id,
          cashCeilingMinor: dto.cashCeilingMinor ?? 1000000,
          isActive: true,
        },
      });
    });

    await this.audit.record({
      staff: req.staff,
      action: "rider.created",
      targetType: "rider",
      targetId: rider.id,
      after: { name: rider.name, phone: rider.phone, email },
      ip: req.ip,
    });

    return {
      id: rider.id,
      name: rider.name,
      phone: rider.phone,
      email,
      // Shown once. Hand it to the rider; it cannot be retrieved later.
      password,
    };
  }

  @Patch(":id")
  @Roles("OWNER", "MANAGER")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateRiderDto,
    @Req() req: AuthedRequest,
  ) {
    const before = await this.prisma.rider.findUnique({
      where: { id },
      include: { staffUser: { select: { id: true } } },
    });
    if (!before) throw new NotFoundException("rider not found");

    const phone = dto.phone ? normalisePhone(dto.phone) : undefined;
    if (phone && phone !== before.phone) {
      const clash = await this.prisma.rider.findUnique({ where: { phone } });
      if (clash) throw new BadRequestException(`${phone} is already registered to another rider`);
    }

    // Retiring a rider mid-trip would strand those stops with nobody able to
    // complete them.
    if (dto.isActive === false) {
      const openStops = await this.prisma.delivery.count({
        where: { riderId: id, status: { in: ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] } },
      });
      if (openStops > 0) {
        throw new BadRequestException(
          `${before.name} still has ${openStops} open ${openStops === 1 ? "stop" : "stops"}. ` +
            "Reassign or close them before switching this rider off.",
        );
      }
      const heldRows = await this.prisma.codCollection.aggregate({
        where: { settlementId: null, collectedAt: { not: null }, delivery: { riderId: id } },
        _sum: { amountCollectedMinor: true },
      });
      const held = heldRows._sum.amountCollectedMinor ?? 0;
      if (held > 0) {
        throw new BadRequestException(
          `${before.name} is still holding ₹${(held / 100).toFixed(2)} in cash. ` +
            "Settle it before switching this rider off.",
        );
      }
    }

    const after = await this.prisma.$transaction(async (tx) => {
      const r = await tx.rider.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(phone ? { phone } : {}),
          ...(dto.vehicleType !== undefined ? { vehicleType: dto.vehicleType?.trim() || null } : {}),
          ...(dto.cashCeilingMinor !== undefined ? { cashCeilingMinor: dto.cashCeilingMinor } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      // Switching a rider off must also stop them signing in.
      if (before.staffUser && (dto.isActive !== undefined || dto.name)) {
        await tx.staffUser.update({
          where: { id: before.staffUser.id },
          data: {
            ...(dto.name ? { name: dto.name.trim() } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      }
      return r;
    });

    await this.audit.record({
      staff: req.staff,
      action: "rider.updated",
      targetType: "rider",
      targetId: id,
      before: { name: before.name, phone: before.phone, isActive: before.isActive },
      after: { name: after.name, phone: after.phone, isActive: after.isActive },
      reason: dto.reason,
      ip: req.ip,
    });
    return after;
  }

  /** There is no self-service password change yet, so staff issue a new one. */
  @Post(":id/reset-password")
  @Roles("OWNER", "MANAGER")
  async resetPassword(
    @Param("id") id: string,
    @Body() dto: ResetRiderPasswordDto,
    @Req() req: AuthedRequest,
  ) {
    const rider = await this.prisma.rider.findUnique({
      where: { id },
      include: { staffUser: { select: { id: true, email: true } } },
    });
    if (!rider) throw new NotFoundException("rider not found");
    if (!rider.staffUser) {
      throw new BadRequestException("this rider has no sign-in account");
    }

    const password = dto.password?.trim() || generatePassword();
    if (password.length < 8) {
      throw new BadRequestException("password must be at least 8 characters");
    }

    await this.prisma.staffUser.update({
      where: { id: rider.staffUser.id },
      data: { passwordHash: await hashPassword(password) },
    });

    await this.audit.record({
      staff: req.staff,
      action: "rider.password_reset",
      targetType: "rider",
      targetId: id,
      after: { email: rider.staffUser.email },
      ip: req.ip,
    });

    return { email: rider.staffUser.email, password };
  }
}

/** Stored E.164 with the leading +, which is what WhatsApp and the UI expect. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 10) throw new BadRequestException("phone number looks too short");
  if (digits.length > 15) throw new BadRequestException("phone number looks too long");
  // A bare 10-digit number is assumed Indian, which is what this shop uses.
  return digits.length === 10 ? `+91${digits}` : `+${digits}`;
}
