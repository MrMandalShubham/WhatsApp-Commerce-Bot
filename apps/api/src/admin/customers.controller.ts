import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";

import { PageQuery, cursorArgs, toPage } from "../common/pagination";
import { PrismaService } from "../prisma/prisma.service";

@Controller("customers")
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: PageQuery) {
    const rows = await this.prisma.customer.findMany({
      orderBy: { id: "asc" },
      take: q.limit + 1,
      ...cursorArgs(q.cursor),
      include: {
        _count: { select: { orders: true, messages: true } },
      },
    });
    const page = toPage(rows, q.limit);
    return {
      ...page,
      data: page.data.map((c) => ({
        id: c.id,
        waPhone: c.waPhone,
        name: c.name,
        isBlocked: c.isBlocked,
        orders: c._count.orders,
        messages: c._count.messages,
        createdAt: c.createdAt,
      })),
    };
  }

  /** Support lookup: the plan's `GET /customers/:phone`. */
  @Get(":phone")
  async byPhone(@Param("phone") phone: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { waPhone: phone },
      include: {
        addresses: { orderBy: { createdAt: "desc" } },
        consents: { orderBy: { occurredAt: "desc" }, take: 5 },
        sessions: true,
        carts: {
          where: { status: "ACTIVE" },
          include: { items: { include: { product: { select: { title: true } } } } },
        },
      },
    });
    if (!customer) throw new NotFoundException("customer not found");

    const session = customer.sessions[0];
    return {
      id: customer.id,
      waPhone: customer.waPhone,
      name: customer.name,
      isBlocked: customer.isBlocked,
      // The support agent needs to know whether they can reply free-form or
      // must use an approved template.
      serviceWindow: session?.windowExpiresAt
        ? {
            open: session.windowExpiresAt > new Date(),
            expiresAt: session.windowExpiresAt,
          }
        : { open: false, expiresAt: null },
      flowState: session?.state ?? null,
      consent: customer.consents[0]?.action ?? null,
      addresses: customer.addresses.map((a) => ({
        id: a.id,
        line1: a.line1,
        landmark: a.landmark,
        pincode: a.pincode,
        latitude: a.latitude,
        longitude: a.longitude,
        source: a.source,
      })),
      activeCart: customer.carts[0]
        ? customer.carts[0].items.map((i) => ({
            title: i.product.title,
            quantity: i.quantity,
            unitPriceMinor: i.unitPriceMinor,
          }))
        : [],
    };
  }

  /** Conversation transcript for support. */
  @Get(":phone/messages")
  async messages(@Param("phone") phone: string, @Query() q: PageQuery) {
    const customer = await this.prisma.customer.findUnique({
      where: { waPhone: phone },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException("customer not found");

    const rows = await this.prisma.whatsappMessage.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...cursorArgs(q.cursor),
    });
    const page = toPage(rows, q.limit);
    return {
      ...page,
      data: page.data.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        status: m.status,
        createdAt: m.createdAt,
        preview: preview(m.payload),
      })),
    };
  }
}

/** Pull something human-readable out of whichever payload shape this is. */
function preview(payload: unknown): string {
  const p = payload as Record<string, any>;
  return (
    p?.text?.body ??
    p?.interactive?.body?.text ??
    p?.template?.name ??
    p?.type ??
    ""
  )
    .toString()
    .slice(0, 160);
}
