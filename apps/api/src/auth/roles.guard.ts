import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { StaffRole } from "@prisma/client";

import { ROLES } from "./roles.decorator";
import type { AuthedRequest } from "./jwt.guard";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[]>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const role = req.staff?.role;
    if (!role || !required.includes(role)) {
      throw new ForbiddenException(`requires role: ${required.join(" or ")}`);
    }
    return true;
  }
}
