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
  Query,
  Req,
} from "@nestjs/common";

import { AuditService } from "../common/audit.service";
import { PageQuery, cursorArgs, toPage } from "../common/pagination";
import { PrismaService } from "../prisma/prisma.service";
import { Roles } from "../auth/roles.decorator";
import type { AuthedRequest } from "../auth/jwt.guard";
import {
  AdjustStockDto,
  CreateProductDto,
  ProductQuery,
  UpdateProductDto,
} from "./dto/product.dto";

@Controller("products")
export class ProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query() q: ProductQuery) {
    const rows = await this.prisma.product.findMany({
      where: {
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.active !== undefined ? { isActive: q.active } : {}),
        ...(q.search
          ? {
              OR: [
                { title: { contains: q.search, mode: "insensitive" as const } },
                { sku: { contains: q.search, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: {
        category: { select: { id: true, name: true } },
        inventory: { select: { onHand: true, reserved: true } },
      },
      orderBy: { id: "asc" },
      take: q.limit + 1,
      ...cursorArgs(q.cursor),
    });

    const page = toPage(rows, q.limit);
    return {
      ...page,
      data: page.data.map(shape),
    };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        inventory: { select: { onHand: true, reserved: true } },
        variants: true,
      },
    });
    if (!product) throw new NotFoundException("product not found");
    return shape(product);
  }

  @Post()
  @Roles("OWNER", "MANAGER")
  async create(@Body() dto: CreateProductDto, @Req() req: AuthedRequest) {
    const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
    if (existing) throw new BadRequestException(`SKU ${dto.sku} already exists`);

    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          sku: dto.sku,
          title: dto.title,
          description: dto.description,
          categoryId: dto.categoryId,
          hsnCode: dto.hsnCode,
          gstRate: dto.gstRate,
          priceMinor: dto.priceMinor,
          imageUrl: dto.imageUrl,
          isActive: dto.isActive ?? true,
        },
      });
      // A product with no inventory row is invisible to the bot, which reads
      // availability as onHand - reserved. Create it up front.
      await tx.inventory.create({
        data: { productId: created.id, onHand: dto.onHand ?? 0, reserved: 0 },
      });
      return created;
    });

    await this.audit.record({
      staff: req.staff,
      action: "product.created",
      targetType: "product",
      targetId: product.id,
      after: product,
      ip: req.ip,
    });
    return product;
  }

  @Patch(":id")
  @Roles("OWNER", "MANAGER")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: AuthedRequest,
  ) {
    const before = await this.prisma.product.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("product not found");

    // `reason` belongs on the audit entry, not on the product row - passing
    // it through to Prisma would throw on an unknown column.
    const { reason, ...changes } = dto;
    const after = await this.prisma.product.update({ where: { id }, data: changes });

    await this.audit.record({
      staff: req.staff,
      action: "product.updated",
      targetType: "product",
      targetId: id,
      before,
      after,
      reason,
      ip: req.ip,
    });
    return after;
  }

  /**
   * Stock is adjusted by a delta with a mandatory reason, never set blindly -
   * "why did we lose 12 units" has to be answerable from the audit log.
   * `reserved` is owned by the checkout flow and is never touched here.
   */
  @Post(":id/stock")
  @Roles("OWNER", "MANAGER", "OPERATOR")
  async adjustStock(
    @Param("id") id: string,
    @Body() dto: AdjustStockDto,
    @Req() req: AuthedRequest,
  ) {
    const inventory = await this.prisma.inventory.findFirst({
      where: { productId: id, variantId: null },
    });
    if (!inventory) throw new NotFoundException("no inventory row for this product");

    const newOnHand = inventory.onHand + dto.delta;
    if (newOnHand < 0) {
      throw new BadRequestException(
        `adjustment would make stock negative (on hand ${inventory.onHand}, delta ${dto.delta})`,
      );
    }
    if (newOnHand < inventory.reserved) {
      throw new BadRequestException(
        `cannot drop below reserved stock (${inventory.reserved} held by active carts)`,
      );
    }

    const after = await this.prisma.inventory.update({
      where: { id: inventory.id },
      data: { onHand: newOnHand },
    });

    await this.audit.record({
      staff: req.staff,
      action: "inventory.adjusted",
      targetType: "product",
      targetId: id,
      before: { onHand: inventory.onHand },
      after: { onHand: after.onHand },
      reason: dto.reason,
      ip: req.ip,
    });

    return { onHand: after.onHand, reserved: after.reserved, available: after.onHand - after.reserved };
  }

  /**
   * Removes a product outright.
   *
   * Only ever allowed for a product with no order history. Once something has
   * been sold, deleting it would sever the link from those order lines - the
   * invoice text survives via the snapshots, but the trail back to the
   * catalogue does not. In that case the honest operation is to deactivate,
   * which hides it from customers and keeps the history intact.
   */
  @Delete(":id")
  @Roles("OWNER", "MANAGER")
  async remove(@Param("id") id: string, @Req() req: AuthedRequest) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { _count: { select: { orderItems: true, cartItems: true } } },
    });
    if (!product) throw new NotFoundException("product not found");

    if (product._count.orderItems > 0) {
      throw new BadRequestException(
        `${product.title} appears on ${product._count.orderItems} order line(s) and cannot be deleted. ` +
          "Switch it off with \"Available to order\" instead - it disappears from the catalogue " +
          "and the order history stays intact.",
      );
    }
    if (product._count.cartItems > 0) {
      throw new BadRequestException(
        "A customer has this product in an open cart right now. Try again once the cart is " +
          "converted or expires, or switch the product off instead.",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Release any stock this product was holding before its inventory rows
      // cascade away, so the counters do not drift.
      const inventories = await tx.inventory.findMany({
        where: { productId: id },
        select: { id: true },
      });
      await tx.inventoryReservation.updateMany({
        where: { inventoryId: { in: inventories.map((i) => i.id) }, releasedAt: null },
        data: { releasedAt: new Date() },
      });
      // inventory, reservations and variants cascade from the product row
      await tx.product.delete({ where: { id } });
    });

    await this.audit.record({
      staff: req.staff,
      action: "product.deleted",
      targetType: "product",
      targetId: id,
      before: { sku: product.sku, title: product.title, priceMinor: product.priceMinor },
      ip: req.ip,
    });

    return { deleted: true, sku: product.sku };
  }
}

function shape(p: {
  id: string;
  sku: string;
  title: string;
  priceMinor: number;
  gstRate: unknown;
  isActive: boolean;
  imageUrl?: string | null;
  category?: { id: string; name: string } | null;
  inventory?: Array<{ onHand: number; reserved: number }>;
}) {
  const inv = p.inventory?.[0];
  return {
    id: p.id,
    sku: p.sku,
    title: p.title,
    priceMinor: p.priceMinor,
    gstRate: Number(p.gstRate),
    isActive: p.isActive,
    imageUrl: p.imageUrl ?? null,
    category: p.category ?? null,
    stock: inv
      ? { onHand: inv.onHand, reserved: inv.reserved, available: inv.onHand - inv.reserved }
      : null,
  };
}
