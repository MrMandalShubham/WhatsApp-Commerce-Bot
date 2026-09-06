import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

/**
 * Cursor pagination, not offset. An admin scrolling orders while new ones
 * arrive would see duplicates and skips with OFFSET; a cursor is stable.
 */
export class PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Fetch limit+1 rows, then trim - tells us whether another page exists. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
}

export function cursorArgs(
  cursor?: string,
): { cursor?: { id: string }; skip?: number } {
  return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
}
