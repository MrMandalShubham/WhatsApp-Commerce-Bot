import { Type } from "class-transformer";
import {
  IsIn, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Length, Min,
} from "class-validator";

export class StartTripDto {
  @IsOptional() @Type(() => Number) @IsLatitude() latitude?: number;
  @IsOptional() @Type(() => Number) @IsLongitude() longitude?: number;
}

export class PingDto {
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) accuracyM?: number;
  @IsOptional() @IsString() deliveryId?: string;
}

export class CompleteDeliveryDto {
  @IsIn(["DELIVERED", "FAILED"]) outcome!: "DELIVERED" | "FAILED";

  /** Required for COD: what the rider actually took, which may be short. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) amountCollectedMinor?: number;

  @IsOptional() @IsIn(["NONE", "PHOTO", "OTP", "SIGNATURE"])
  podType?: "NONE" | "PHOTO" | "OTP" | "SIGNATURE";

  @IsOptional() @IsString() podPhotoUrl?: string;
  @IsOptional() @IsString() @Length(1, 120) recipientName?: string;
  @IsOptional() @IsString() @Length(1, 300) note?: string;
}

export class SettleCashDto {
  @IsString() riderId!: string;
  @Type(() => Number) @IsInt() @Min(0) receivedMinor!: number;
  @IsOptional() @IsString() @Length(1, 300) note?: string;
}
