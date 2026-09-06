import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AdminModule } from "./admin/admin.module";
import { AuthModule } from "./auth/auth.module";
import { JwtGuard } from "./auth/jwt.guard";
import { RolesGuard } from "./auth/roles.guard";
import { HealthModule } from "./health/health.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { RiderModule } from "./rider/rider.module";
import { TrackingModule } from "./tracking/tracking.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    AuthModule,
    HealthModule,
    WebhooksModule,
    AdminModule,
    RiderModule,
    TrackingModule,
  ],
  providers: [
    // Authentication is on by default; routes opt out with @Public().
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
