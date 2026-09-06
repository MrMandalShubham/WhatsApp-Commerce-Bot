import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertTransition,
  buildOrderLines,
  computeTotals,
  formatOrderNumber,
  type CartSource,
  type CartTotals,
  type DeliveryZone,
} from "@wcb/core";

/**
 * Serviceability for a pin, answered by PostGIS.
 *
 * A polygon test is far more accurate than a PIN-code list, which routinely
 * straddles serviceable and non-serviceable streets. Smallest matching area
 * wins so a special inner zone can override a broad one.
 */
export async function resolveDeliveryZone(
  prisma: PrismaClient,
  latitude: number,
  longitude: number,
): Promise<DeliveryZone> {
  const rows = await prisma.$queryRaw<
    Array<{
      name: string;
      codAllowed: boolean;
      codMaxOrderMinor: number | null;
      deliveryFeeMinor: number;
      minOrderValueMinor: number;
    }>
  >`
    SELECT name,
           "codAllowed",
           "codMaxOrderMinor",
           "deliveryFeeMinor",
           "minOrderValueMinor"
      FROM service_areas
     WHERE "isActive" = true
       AND polygon IS NOT NULL
       AND ST_Contains(polygon::geometry,
                       ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326))
     ORDER BY ST_Area(polygon::geometry) ASC
     LIMIT 1`;

  const area = rows[0];
  if (!area) {
    return {
      serviceable: false,
      codAllowed: false,
      deliveryFeeMinor: 0,
      minOrderValueMinor: 0,
    };
  }
  return {
    serviceable: true,
    areaName: area.name,
    codAllowed: area.codAllowed,
    codMaxOrderMinor: area.codMaxOrderMinor,
    deliveryFeeMinor: area.deliveryFeeMinor,
    minOrderValueMinor: area.minOrderValueMinor,
  };
}

/**
 * Collapses a new pin onto an existing address when it lands within ~25 m of
 * one the customer already has, so repeat ordering does not sprawl the
 * address list.
 */
export async function findNearbyAddress(
  prisma: PrismaClient,
  customerId: string,
  latitude: number,
  longitude: number,
  metres = 25,
): Promise<{ id: string } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM customer_addresses
     WHERE "customerId" = ${customerId}
       AND location IS NOT NULL
       AND ST_DWithin(location,
                      ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography,
                      ${metres})
     ORDER BY location <-> ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
     LIMIT 1`;
  return rows[0] ?? null;
}

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  totals: CartTotals;
  totalMinor: number;
}

/**
 * Freezes the active cart into an order.
 *
 * Everything happens in one transaction: line snapshots, reservation hand-off
 * from cart to order, cart closure, and the first status-history rows. A
 * partial order with orphaned stock holds is not a state we want to recover
 * from by hand.
 */
export async function createOrderFromCart(
  prisma: PrismaClient,
  params: {
    customerId: string;
    addressId: string | null;
    paymentMode: "COD" | "ONLINE";
    zone: DeliveryZone;
  },
): Promise<CreatedOrder> {
  return prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findFirst({
      where: { customerId: params.customerId, status: "ACTIVE" },
      include: {
        items: {
          include: {
            product: { select: { id: true, title: true, sku: true, hsnCode: true, gstRate: true } },
          },
        },
      },
    });
    if (!cart || cart.items.length === 0) throw new Error("no active cart to convert");

    const source: CartSource[] = cart.items.map((i) => ({
      productId: i.product.id,
      sku: i.product.sku,
      hsnCode: i.product.hsnCode,
      title: i.product.title,
      // The price captured when the item went into the cart, not today's
      // catalogue price - the customer agreed to this figure.
      unitPriceMinor: i.unitPriceMinor,
      quantity: i.quantity,
      gstRatePercent: Number(i.product.gstRate),
    }));

    const { lines } = buildOrderLines(source);
    const totals = computeTotals(source, params.zone.deliveryFeeMinor);

    const [{ nextval }] = await tx.$queryRaw<Array<{ nextval: bigint }>>`
      SELECT nextval('order_number_seq') AS nextval`;
    const orderNumber = formatOrderNumber(Number(nextval));

    const isCod = params.paymentMode === "COD";

    const order = await tx.order.create({
      data: {
        orderNumber,
        customerId: params.customerId,
        addressId: params.addressId,
        paymentMode: params.paymentMode,
        // COD is NOT_REQUIRED until the rider collects; online starts PENDING.
        paymentStatus: isCod ? "NOT_REQUIRED" : "PENDING",
        fulfillmentStatus: "UNFULFILLED",
        orderStatus: "PLACED",
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        deliveryFeeMinor: totals.deliveryFeeMinor,
        totalMinor: totals.totalMinor,
        currency: "INR",
        placedAt: new Date(),
        items: { create: lines },
      },
      select: { id: true, orderNumber: true },
    });

    // Hand the stock holds from the cart to the order so the sweeper stops
    // treating them as an abandoned checkout.
    await tx.inventoryReservation.updateMany({
      where: { cartId: cart.id, releasedAt: null },
      data: { orderId: order.id, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) },
    });
    await tx.cart.update({ where: { id: cart.id }, data: { status: "CONVERTED" } });

    await tx.orderStatusHistory.createMany({
      data: [
        { orderId: order.id, field: "order_status", fromValue: "DRAFT", toValue: "PLACED", actorType: "CUSTOMER" },
        {
          orderId: order.id, field: "payment_status", fromValue: null,
          toValue: isCod ? "NOT_REQUIRED" : "PENDING", actorType: "CUSTOMER",
        },
      ],
    });

    // A COD order has nothing outstanding at placement, so it is confirmed
    // immediately. An online order stays PLACED until the gateway callback.
    if (isCod) {
      await tx.order.update({ where: { id: order.id }, data: { orderStatus: "CONFIRMED" } });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id, field: "order_status", fromValue: "PLACED",
          toValue: "CONFIRMED", actorType: "SYSTEM", reason: "cash on delivery - no payment pending",
        },
      });
    }

    return { id: order.id, orderNumber: order.orderNumber, totals, totalMinor: totals.totalMinor };
  });
}

/**
 * Applies a guarded status change and records it. Every transition is checked
 * against the state machine and written to the immutable history.
 */
export async function transitionOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  changes: {
    payment?: string;
    fulfillment?: string;
    order?: string;
  },
  actor: { actorType: "CUSTOMER" | "STAFF" | "RIDER" | "SYSTEM" | "PROVIDER"; actorId?: string; reason?: string },
): Promise<void> {
  const current = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { paymentStatus: true, fulfillmentStatus: true, orderStatus: true },
  });

  const map = [
    ["payment", "payment_status", current.paymentStatus, changes.payment, "paymentStatus"],
    ["fulfillment", "fulfillment_status", current.fulfillmentStatus, changes.fulfillment, "fulfillmentStatus"],
    ["order", "order_status", current.orderStatus, changes.order, "orderStatus"],
  ] as const;

  const data: Record<string, string> = {};
  const history: Prisma.OrderStatusHistoryCreateManyInput[] = [];

  for (const [field, column, from, to, prop] of map) {
    if (!to || to === from) continue;
    assertTransition(field, from, to); // throws rather than silently no-opping
    data[prop] = to;
    history.push({
      orderId, field: column, fromValue: from, toValue: to,
      actorType: actor.actorType, actorId: actor.actorId, reason: actor.reason,
    });
  }

  if (!history.length) return;

  await tx.order.update({ where: { id: orderId }, data });
  await tx.orderStatusHistory.createMany({ data: history });
}
