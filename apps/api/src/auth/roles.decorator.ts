import { SetMetadata } from "@nestjs/common";
import type { StaffRole } from "@prisma/client";

export const ROLES = "roles";

export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES, roles);
