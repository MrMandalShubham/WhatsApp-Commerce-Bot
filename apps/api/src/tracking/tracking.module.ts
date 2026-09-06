import { Module } from "@nestjs/common";

import { PositionService } from "../common/position.service";
import { TrackingController } from "./tracking.controller";

@Module({
  controllers: [TrackingController],
  providers: [PositionService],
})
export class TrackingModule {}
