import { Type } from "class-transformer";
import {
  IsBoolean, IsEmail, IsInt, IsOptional, IsString, Length, Min,
} from "class-validator";

export class CreateRiderDto {
  @IsString() @Length(2, 80) name!: string;
  @IsString() @Length(10, 20) phone!: string;

  /** The rider signs in with this. */
  @IsEmail() email!: string;

  /** Optional — one is generated and returned once when omitted. */
  @IsOptional() @IsString() @Length(8, 100) password?: string;

  @IsOptional() @IsString() @Length(1, 40) vehicleType?: string;

  /** Undeposited cash allowed before COD assignments are blocked. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cashCeilingMinor?: number;
}

export class UpdateRiderDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @Length(10, 20) phone?: string;
  @IsOptional() @IsString() @Length(0, 40) vehicleType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) cashCeilingMinor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @Length(3, 300) reason?: string;
}

export class ResetRiderPasswordDto {
  @IsOptional() @IsString() @Length(8, 100) password?: string;
}
