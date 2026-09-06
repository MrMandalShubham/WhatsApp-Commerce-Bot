import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";

import { AuditService } from "../common/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";
import { SaveServiceAreaDto, TestPointDto } from "./dto/service-area.dto";

interface AreaRow {
  id: string;
  name: string;
  isActive: boolean;
  codAllowed: boolean;
  codMaxOrderMinor: number | null;
  deliveryFeeMinor: number;
  minOrderValueMinor: number;
  ring: string | null;
  area_km2: number | null;
}

/**
 * Delivery zones as polygons.
 *
 * A polygon is the thing the whole delivery layer runs on: serviceability,
 * the delivery fee, the minimum order and the COD ceiling are all answered by
 * "which area contains this pin". PIN-code lists cannot do that — one PIN
 * routinely covers streets the shop will and will not deliver to.
 */
@Controller("service-areas")
export class ServiceAreasController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    // The polygon column is a PostGIS type Prisma cannot read, so the ring
    // comes back as JSON and is parsed here.
    const rows = await this.prisma.$queryRaw<AreaRow[]>`
      SELECT id, name, "isActive", "codAllowed", "codMaxOrderMinor",
             "deliveryFeeMinor", "minOrderValueMinor",
             CASE WHEN polygon IS NULL THEN NULL
                  ELSE ST_AsGeoJSON(polygon::geometry) END AS ring,
             CASE WHEN polygon IS NULL THEN NULL
                  ELSE ROUND((ST_Area(polygon) / 1000000)::numeric, 3)::float8 END AS area_km2
        FROM service_areas
       ORDER BY "isActive" DESC, name ASC`;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isActive: r.isActive,
      codAllowed: r.codAllowed,
      codMaxOrderMinor: r.codMaxOrderMinor,
      deliveryFeeMinor: r.deliveryFeeMinor,
      minOrderValueMinor: r.minOrderValueMinor,
      areaKm2: r.area_km2,
      // [[lng, lat], …] — the outer ring only; holes are not supported.
      points: r.ring ? (JSON.parse(r.ring) as { coordinates: number[][][] }).coordinates[0] : [],
    }));
  }

  @Post()
  @Roles("OWNER", "MANAGER")
  async create(@Body() dto: SaveServiceAreaDto, @Req() req: AuthedRequest) {
    const wkt = toPolygonWkt(dto.points);

    const area = await this.prisma.serviceArea.create({
      data: {
        name: dto.name,
        isActive: dto.isActive ?? true,
        codAllowed: dto.codAllowed ?? true,
        codMaxOrderMinor: dto.codMaxOrderMinor ?? null,
        deliveryFeeMinor: dto.deliveryFeeMinor ?? 0,
        minOrderValueMinor: dto.minOrderValueMinor ?? 0,
      },
      select: { id: true },
    });
    await this.setPolygon(area.id, wkt);

    await this.audit.record({
      staff: req.staff,
      action: "service_area.created",
      targetType: "service_area",
      targetId: area.id,
      after: { name: dto.name, vertices: dto.points.length },
      ip: req.ip,
    });
    return { id: area.id, name: dto.name, vertices: dto.points.length };
  }

  @Patch(":id")
  @Roles("OWNER", "MANAGER")
  async update(
    @Param("id") id: string,
    @Body() dto: SaveServiceAreaDto,
    @Req() req: AuthedRequest,
  ) {
    const before = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("service area not found");

    const wkt = toPolygonWkt(dto.points);
    await this.prisma.serviceArea.update({
      where: { id },
      data: {
        name: dto.name,
        isActive: dto.isActive ?? before.isActive,
        codAllowed: dto.codAllowed ?? before.codAllowed,
        codMaxOrderMinor: dto.codMaxOrderMinor ?? null,
        deliveryFeeMinor: dto.deliveryFeeMinor ?? before.deliveryFeeMinor,
        minOrderValueMinor: dto.minOrderValueMinor ?? before.minOrderValueMinor,
      },
    });
    await this.setPolygon(id, wkt);

    await this.audit.record({
      staff: req.staff,
      action: "service_area.updated",
      targetType: "service_area",
      targetId: id,
      before: { name: before.name, deliveryFeeMinor: before.deliveryFeeMinor },
      after: { name: dto.name, vertices: dto.points.length },
      ip: req.ip,
    });
    return { id, name: dto.name, vertices: dto.points.length };
  }

  @Delete(":id")
  @Roles("OWNER", "MANAGER")
  async remove(@Param("id") id: string, @Req() req: AuthedRequest) {
    const area = await this.prisma.serviceArea.findUnique({ where: { id } });
    if (!area) throw new NotFoundException("service area not found");

    const remaining = await this.prisma.serviceArea.count({
      where: { isActive: true, id: { not: id } },
    });
    if (area.isActive && remaining === 0) {
      // Without a single active area every pin falls outside coverage and
      // every order is handed to a human. Deleting the last one silently is
      // how a shop discovers it has stopped taking orders.
      throw new BadRequestException(
        "This is the only active delivery area. Deleting it would stop the shop " +
          "taking any orders. Add another area first, or switch this one off instead.",
      );
    }

    await this.prisma.serviceArea.delete({ where: { id } });
    await this.audit.record({
      staff: req.staff,
      action: "service_area.deleted",
      targetType: "service_area",
      targetId: id,
      before: { name: area.name },
      ip: req.ip,
    });
    return { deleted: true, name: area.name };
  }

  /**
   * "Would we deliver here?" — the same query the checkout flow runs, exposed
   * so staff can sanity-check a boundary against a real address.
   */
  @Post("test")
  async test(@Body() dto: TestPointDto) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string; name: string; codAllowed: boolean; codMaxOrderMinor: number | null;
        deliveryFeeMinor: number; minOrderValueMinor: number;
      }>
    >`
      SELECT id, name, "codAllowed", "codMaxOrderMinor",
             "deliveryFeeMinor", "minOrderValueMinor"
        FROM service_areas
       WHERE "isActive" = true
         AND polygon IS NOT NULL
         AND ST_Contains(polygon::geometry,
                         ST_SetSRID(ST_MakePoint(${dto.longitude}, ${dto.latitude}), 4326))
       ORDER BY ST_Area(polygon::geometry) ASC
       LIMIT 1`;

    const hit = rows[0];
    return {
      serviceable: Boolean(hit),
      area: hit ?? null,
      message: hit
        ? `Deliverable — ${hit.name}. Delivery ₹${(hit.deliveryFeeMinor / 100).toFixed(2)}, ` +
          `minimum ₹${(hit.minOrderValueMinor / 100).toFixed(2)}` +
          (hit.codAllowed
            ? hit.codMaxOrderMinor
              ? `, COD up to ₹${(hit.codMaxOrderMinor / 100).toFixed(2)}.`
              : ", COD allowed."
            : ", COD not available here.")
        : "Not deliverable — this point is outside every active area.",
    };
  }

  /**
   * Writes the polygon column. The WKT is built only from numbers that have
   * already been validated as finite, so there is nothing injectable left in
   * the string by the time it reaches the query.
   */
  private async setPolygon(id: string, wkt: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE service_areas SET polygon = ST_GeogFromText($1) WHERE id = $2`,
      wkt,
      id,
    );
  }
}

/** [[lng, lat], …] → a closed SRID 4326 polygon ring. */
function toPolygonWkt(points: number[][]): string {
  if (!Array.isArray(points) || points.length < 3) {
    throw new BadRequestException("a delivery area needs at least 3 points");
  }
  if (points.length > 500) {
    throw new BadRequestException("a delivery area cannot have more than 500 points");
  }

  const ring = points.map(([lng, lat], i) => {
    if (
      typeof lng !== "number" || typeof lat !== "number" ||
      !Number.isFinite(lng) || !Number.isFinite(lat)
    ) {
      throw new BadRequestException(`point ${i + 1} is not a valid coordinate pair`);
    }
    if (lat < -90 || lat > 90) throw new BadRequestException(`point ${i + 1}: latitude out of range`);
    if (lng < -180 || lng > 180) throw new BadRequestException(`point ${i + 1}: longitude out of range`);
    return [lng, lat] as [number, number];
  });

  // A WKT ring must close on itself; the map only ever sends open rings.
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

  const coords = ring.map(([lng, lat]) => `${lng} ${lat}`).join(", ");
  return `SRID=4326;POLYGON((${coords}))`;
}
