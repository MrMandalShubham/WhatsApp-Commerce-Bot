import { Module } from "@nestjs/common";

import { AuditService } from "../common/audit.service";
import { CategoriesController } from "./categories.controller";
import { CustomersController } from "./customers.controller";
import { OpsController } from "./ops.controller";
import { OrderActionsController } from "./order-actions.controller";
import { OrdersController } from "./orders.controller";
import { ProductsController } from "./products.controller";
import { ReportsController } from "./reports.controller";
import { RidersController } from "./riders.controller";
import { ServiceAreasController } from "./service-areas.controller";

@Module({
  controllers: [
    ProductsController,
    CategoriesController,
    CustomersController,
    OrdersController,
    OrderActionsController,
    ReportsController,
    OpsController,
    ServiceAreasController,
    RidersController,
  ],
  providers: [AuditService],
})
export class AdminModule {}
