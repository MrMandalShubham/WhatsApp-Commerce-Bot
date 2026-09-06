import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { StaffRole } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";
import { verifyPassword } from "./password";

export interface JwtPayload {
  sub: string;
  email: string;
  role: StaffRole;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<{ accessToken: string; user: object }> {
    const user = await this.prisma.staffUser.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Same rejection whether the account is missing, disabled, or the password
    // is wrong - a caller must not be able to enumerate staff accounts.
    const ok = user?.isActive && (await verifyPassword(user.passwordHash, password));
    if (!ok || !user) {
      this.logger.warn(`Failed login for ${email}`);
      throw new UnauthorizedException("invalid credentials");
    }

    await this.prisma.staffUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }
}
