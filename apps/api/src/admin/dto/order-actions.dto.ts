import { Type } from "class-transformer";
import {
  IsBoolean, IsInt, IsLatitude, IsLongitude, IsOptional, IsString, Length, Max, Min,
} from "class-validator";

export class CancelOrderDto {
  @IsString() @Length(3, 300) reason!: string;

  /** Guard against cancelling a paid order without noticing money is owed. */
  @IsOptional() @IsBoolean() acknowledgeRefundDue?: boolean;
}

export class RefundDto {
  @Type(() => Number) @IsInt() @Min(1) amountMinor!: number;
  @IsString() @Length(3, 300) reason!: string;
}

export class ResendLinkDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(15) @Max(1440) expiresInMinutes?: number;
}

export class CorrectLocationDto {
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsOptional() @IsString() @Length(1, 300) landmark?: string;
  @IsString() @Length(3, 300) reason!: string;
}
