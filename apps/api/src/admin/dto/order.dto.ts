import { IsIn, IsOptional, IsString, Length } from "class-validator";

import { PageQuery } from "../../common/pagination";

const ORDER = ["DRAFT", "PLACED", "CONFIRMED", "COMPLETED", "CANCELLED"] as const;
const FULFILLMENT = [
  "UNFULFILLED", "CONFIRMED", "PACKED", "ASSIGNED",
  "OUT_FOR_DELIVERY", "DELIVERED", "FAILED_DELIVERY", "RETURNED",
] as const;
const PAYMENT = [
  "NOT_REQUIRED", "PENDING", "LINK_SENT", "PAID",
  "FAILED", "EXPIRED", "REFUND_PENDING", "REFUNDED",
] as const;

export class OrderQuery extends PageQuery {
  @IsOptional() @IsIn(ORDER as unknown as string[]) status?: (typeof ORDER)[number];
  @IsOptional() @IsIn(FULFILLMENT as unknown as string[]) fulfillment?: (typeof FULFILLMENT)[number];
  @IsOptional() @IsIn(PAYMENT as unknown as string[]) payment?: (typeof PAYMENT)[number];
  @IsOptional() @IsString() phone?: string;
}

export class ChangeStatusDto {
  @IsIn(["payment", "fulfillment", "order"])
  field!: "payment" | "fulfillment" | "order";

  @IsString()
  to!: string;

  /** Manual overrides always carry a reason - it lands on the audit log. */
  @IsString() @Length(3, 300) reason!: string;
}

export class AssignRiderDto {
  @IsString() riderId!: string;
}
