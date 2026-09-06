import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { env } from "../config/env";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtGuard } from "./jwt.guard";
import { RolesGuard } from "./roles.guard";

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: "12h" },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtGuard, RolesGuard],
  exports: [JwtModule, JwtGuard, RolesGuard],
})
export class AuthModule {}
