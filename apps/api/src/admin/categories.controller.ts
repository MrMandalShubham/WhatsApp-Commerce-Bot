import {
  BadRequestException,
  Body,
  Controller,
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
import { CreateCategoryDto, UpdateCategoryDto } from "./dto/product.dto";

@Controller("categories")
export class CategoriesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const rows = await this.prisma.category.findMany({
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { products: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      productCount: c._count.products,
    }));
  }

  @Post()
  @Roles("OWNER", "MANAGER")
  async create(@Body() dto: CreateCategoryDto, @Req() req: AuthedRequest) {
    const clash = await this.prisma.category.findUnique({ where: { slug: dto.slug } });
    if (clash) throw new BadRequestException(`slug ${dto.slug} already exists`);

    const category = await this.prisma.category.create({ data: dto });
    await this.audit.record({
      staff: req.staff,
      action: "category.created",
      targetType: "category",
      targetId: category.id,
      after: category,
      ip: req.ip,
    });
    return category;
  }

  @Patch(":id")
  @Roles("OWNER", "MANAGER")
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateCategoryDto,
    @Req() req: AuthedRequest,
  ) {
    const before = await this.prisma.category.findUnique({ where: { id } });
    if (!before) throw new NotFoundException("category not found");

    const after = await this.prisma.category.update({ where: { id }, data: { ...dto } });
    await this.audit.record({
      staff: req.staff,
      action: "category.updated",
      targetType: "category",
      targetId: id,
      before,
      after,
      ip: req.ip,
    });
    return after;
  }
}
