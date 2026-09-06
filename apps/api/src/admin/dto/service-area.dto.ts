import { Type } from "class-transformer";
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsLatitude,
  IsLongitude, IsOptional, IsString, Length, Min,
} from "class-validator";

export class SaveServiceAreaDto {
  @IsString() @Length(2, 80) name!: string;

  /** Outer ring as [[lng, lat], …]. Ordering matches GeoJSON, not lat/lng. */
  @IsArray() @ArrayMinSize(3) @ArrayMaxSize(500)
  points!: number[][];

  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() codAllowed?: boolean;

  /** Null means no COD ceiling in this area. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) codMaxOrderMinor?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) deliveryFeeMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minOrderValueMinor?: number;
}

export class TestPointDto {
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
}
