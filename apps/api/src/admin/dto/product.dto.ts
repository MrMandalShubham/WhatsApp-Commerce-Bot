import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

import { PageQuery } from "../../common/pagination";

export class ProductQuery extends PageQuery {
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() search?: string;

  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : value === "false" ? false : value))
  @IsBoolean()
  active?: boolean;
}

export class CreateProductDto {
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z0-9-]+$/i, { message: "sku may contain letters, digits and hyphens only" })
  sku!: string;

  @IsString() @Length(2, 200) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() @Length(4, 8) hsnCode?: string;

  /** GST percent, e.g. 5 / 12 / 18. */
  @IsNumber() @Min(0) @Max(50) gstRate!: number;

  /** Price in paise, GST-inclusive. 27500 = Rs 275.00 */
  @IsInt() @Min(1) priceMinor!: number;

  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) onHand?: number;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @Length(2, 200) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsString() @Length(4, 8) hsnCode?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(50) gstRate?: number;
  @IsOptional() @IsInt() @Min(1) priceMinor?: number;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;

  /** Recorded on the audit entry - why the price or status changed. */
  @IsOptional() @IsString() @Length(3, 300) reason?: string;
}

export class AdjustStockDto {
  /** Signed change: +50 on delivery, -3 on breakage. */
  @Type(() => Number)
  @IsInt()
  delta!: number;

  @IsString() @Length(3, 300) reason!: string;
}

export class CreateCategoryDto {
  @IsString() @Length(2, 80) name!: string;
  @IsString() @Matches(/^[a-z0-9-]+$/, { message: "slug must be lowercase-with-hyphens" }) slug!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
