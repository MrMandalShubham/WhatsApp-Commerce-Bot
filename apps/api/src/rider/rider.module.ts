import { Module } from "@nestjs/common";

import { AuditService } from "../common/audit.service";
import { PositionService } from "../common/position.service";
import { RiderController } from "./rider.controller";

@Module({
  controllers: [RiderController],
  providers: [AuditService, PositionService],
  exports: [PositionService],
})
export class RiderModule {}
