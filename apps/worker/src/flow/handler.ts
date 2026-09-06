import type { PrismaClient } from "@prisma/client";
import {
  ACTIONS,
  FlowState,
  step,
  type CartLineInput,
  type Effect,
  type FlowContext,
  type FlowInput,
  type ProductView,
  type Reply,
} from "@wcb/core";
import type { InboundMessage, WhatsAppProvider } from "@wcb/whatsapp";
import type { PaymentProvider } from "@wcb/payments";
import { renderOrderPlaced, renderPaymentLink } from "@wcb/core";

import { renderReply } from "./render";
import { createOrderFromCart, resolveDeliveryZone, transitionOrder } from "./orders";

const SHOP_NAME = process.env.SHOP_NAME ?? "our shop";
const CURRENCY = process.env.DEFAULT_CURRENCY ?? "INR";
const RESERVATION_TTL_MIN = Number(process.env.RESERVATION_TTL_MINUTES ?? 30);
const SESSION_TTL_MIN = Number(process.env.SESSION_TTL_MINUTES ?? 30);
const LINK_TTL_MIN = Number(process.env.PAYMENT_LINK_TTL_MINUTES ?? 30);
const API_URL = process.env.API_PUBLIC_URL ?? "http://localhost:3000";

interface SessionContext {
  lastOrderId?: string | null;
  failureCount?: number;
  pendingProductId?: string | null;
  selectedCategoryId?: string | null;
  pendingAddressId?: string | null;
}

/**
 * Glue between the pure flow machine and the world: load context, run the
 * machine, apply its effects transactionally, then send the replies.
 */
export async function handleInbound(
  prisma: PrismaClient,
  provider: WhatsAppProvider,
  payments: PaymentProvider,
  message: InboundMessage,
): Promise<void> {
  const customer = await prisma.customer.upsert({
    where: { waPhone: message.from },
    update: message.profileName ? { name: message.profileName } : {},
    create: { waPhone: message.from, name: message.profileName ?? null },
  });

  if (customer.isBlocked) {
    log("flow.blocked", { customerId: customer.id });
    return;
  }

  const now = new Date();
  const session = await prisma.whatsappSession.upsert({
    where: { customerId: customer.id },
    update: {
      lastInboundAt: now,
      // Any inbound message opens or extends the 24-hour service window.
      windowExpiresAt: new Date(now.getTime() + 24 * 3600_000),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MIN * 60_000),
    },
    create: {
      customerId: customer.id,
      state: FlowState.GREETING,
      lastInboundAt: now,
      windowExpiresAt: new Date(now.getTime() + 24 * 3600_000),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MIN * 60_000),
    },
  });

  // An expired session keeps the cart but drops the step, so a customer
  // returning after a day is greeted rather than resumed mid-question.
  const sessionExpired =
    session.expiresAt !== null && session.expiresAt < now && session.updatedAt < now;
  const currentState = sessionExpired
    ? FlowState.IDLE
    : (session.state as FlowState);

  const sctx = (session.context ?? {}) as SessionContext;
  const ctx = await buildContext(prisma, customer.id, currentState, sctx);

  // Resolve serviceability for the pin the customer shared, so the machine can
  // decide COD eligibility, delivery fee and minimum order without touching
  // the database itself.
  if (sctx.pendingAddressId) {
    const addr = await prisma.customerAddress.findUnique({
      where: { id: sctx.pendingAddressId },
      select: { latitude: true, longitude: true },
    });
    if (addr?.latitude != null && addr.longitude != null) {
      ctx.delivery = await resolveDeliveryZone(
        prisma, Number(addr.latitude), Number(addr.longitude),
      );
    }
  }

  const input: FlowInput = {
    text: message.text,
    replyId: message.replyId,
    location: message.location,
  };

  const result = step(input, ctx);

  const followUps = await applyEffects(
    prisma, customer.id, message.from, result.effects, sctx, provider, payments,
  );

  await prisma.whatsappSession.update({
    where: { customerId: customer.id },
    data: {
      state: result.state,
      step: result.state,
      context: sctx as object,
    },
  });

  for (const reply of [...result.replies, ...followUps]) {
    const outbound = renderReply(message.from, reply);
    const sent = await provider.send(outbound);
    await prisma.whatsappMessage.create({
      data: {
        customerId: customer.id,
        direction: "OUTBOUND",
        providerMessageId: sent.providerMessageId,
        type: (outbound.type as string) ?? "text",
        payload: outbound as object,
        status: sent.stubbed ? "QUEUED" : "SENT",
        sentAt: new Date(),
      },
    });
  }

  log("flow.step", {
    customerId: customer.id,
    from: currentState,
    to: result.state,
    replies: result.replies.length,
    effects: result.effects.map((e) => e.type),
  });
}

// ---------------------------------------------------------------------------

async function buildContext(
  prisma: PrismaClient,
  customerId: string,
  state: FlowState,
  sctx: SessionContext,
): Promise<FlowContext> {
  const [categories, consent, cart] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true },
    }),
    prisma.customerConsent.findFirst({
      where: { customerId },
      orderBy: { occurredAt: "desc" },
      select: { action: true },
    }),
    prisma.cart.findFirst({
      where: { customerId, status: "ACTIVE" },
      include: {
        items: {
          include: {
            product: { select: { title: true, gstRate: true } },
          },
        },
      },
    }),
  ]);

  // Available = on hand minus what other in-flight carts are holding.
  const rows = await prisma.product.findMany({
    where: { isActive: true },
    select: {
      id: true,
      title: true,
      priceMinor: true,
      gstRate: true,
      categoryId: true,
      inventory: { select: { onHand: true, reserved: true } },
    },
  });

  const products: Array<ProductView & { categoryId: string | null }> = rows.map((p) => {
    const inv = p.inventory[0];
    return {
      id: p.id,
      title: p.title,
      priceMinor: p.priceMinor,
      gstRatePercent: Number(p.gstRate),
      available: inv ? Math.max(0, inv.onHand - inv.reserved) : 0,
      categoryId: p.categoryId,
    };
  });

  const cartLines: CartLineInput[] = (cart?.items ?? []).map((i) => ({
    title: i.product.title,
    unitPriceMinor: i.unitPriceMinor,
    quantity: i.quantity,
    gstRatePercent: Number(i.product.gstRate),
  }));

  return {
    state,
    shopName: SHOP_NAME,
    currency: CURRENCY,
    hasOptedIn: consent?.action === "OPT_IN",
    failureCount: sctx.failureCount ?? 0,
    pendingProductId: sctx.pendingProductId ?? null,
    selectedCategoryId: sctx.selectedCategoryId ?? null,
    cartLines,
    cartItemCount: cartLines.reduce((n, l) => n + l.quantity, 0),
    categories,
    productsInCategory: (id) => products.filter((p) => p.categoryId === id),
    findProduct: (id) => products.find((p) => p.id === id),
  };
}

async function applyEffects(
  prisma: PrismaClient,
  customerId: string,
  waPhone: string,
  effects: Effect[],
  sctx: SessionContext,
  provider: WhatsAppProvider,
  payments: PaymentProvider,
): Promise<Reply[]> {
  const followUps: Reply[] = [];
  // Any successful step clears the failure streak; only the explicit
  // increment effect below re-arms it.
  if (!effects.some((e) => e.type === ACTIONS.INCREMENT_FAILURE)) {
    sctx.failureCount = 0;
  }

  for (const effect of effects) {
    switch (effect.type) {
      case ACTIONS.INCREMENT_FAILURE:
        sctx.failureCount = (sctx.failureCount ?? 0) + 1;
        break;

      case ACTIONS.SET_CATEGORY:
        sctx.selectedCategoryId = effect.categoryId;
        break;

      case ACTIONS.SET_PENDING_PRODUCT:
        sctx.pendingProductId = effect.productId;
        break;

      case ACTIONS.RECORD_CONSENT:
        await prisma.customerConsent.create({
          data: {
            customerId,
            action: effect.action,
            source: "whatsapp_greeting",
            channel: "whatsapp",
            wordingShown: effect.wordingShown,
          },
        });
        break;

      case ACTIONS.ADD_TO_CART:
        await addToCart(prisma, customerId, effect.productId, effect.quantity);
        break;

      case ACTIONS.CLEAR_CART:
        await clearCart(prisma, customerId);
        break;

      case ACTIONS.SAVE_LOCATION:
        sctx.pendingAddressId = await saveLocation(prisma, customerId, effect);
        break;

      case ACTIONS.SAVE_LANDMARK:
        if (sctx.pendingAddressId && effect.note) {
          await prisma.customerAddress.update({
            where: { id: sctx.pendingAddressId },
            data: { landmark: effect.note },
          });
        }
        break;

      case ACTIONS.CREATE_ORDER: {
        const order = await createOrderFromCart(prisma, {
          customerId,
          addressId: sctx.pendingAddressId ?? null,
          paymentMode: effect.paymentMode,
          zone: (await zoneFor(prisma, sctx.pendingAddressId)) ?? {
            serviceable: true, codAllowed: true, deliveryFeeMinor: 0, minOrderValueMinor: 0,
          },
        });
        sctx.pendingAddressId = null;
        sctx.lastOrderId = order.id;

        if (effect.paymentMode === "COD") {
          followUps.push({
            kind: "text",
            text: renderOrderPlaced({
              orderNumber: order.orderNumber,
              totals: order.totals,
              paymentMode: "COD",
              currency: CURRENCY,
            }),
          });
        } else {
          const link = await payments.createLink({
            referenceId: order.orderNumber,
            amountMinor: order.totalMinor,
            currency: CURRENCY,
            description: `Order ${order.orderNumber}`,
            customerPhone: waPhone,
            expiresInMinutes: LINK_TTL_MIN,
            callbackUrl: `${API_URL}/pay/return`,
          });

          await prisma.$transaction(async (tx) => {
            await tx.payment.create({
              data: {
                orderId: order.id,
                attemptNo: 1,
                provider: "razorpay",
                providerLinkId: link.providerLinkId,
                status: "LINK_SENT",
                amountMinor: order.totalMinor,
                currency: CURRENCY,
                linkUrl: link.url,
                linkExpiresAt: link.expiresAt,
              },
            });
            await transitionOrder(
              tx, order.id, { payment: "LINK_SENT" },
              { actorType: "SYSTEM", reason: "payment link issued" },
            );
          });

          followUps.push({
            kind: "text",
            text: renderPaymentLink({
              orderNumber: order.orderNumber,
              totals: order.totals,
              url: link.url,
              expiresInMinutes: LINK_TTL_MIN,
              currency: CURRENCY,
            }),
          });
        }
        break;
      }

      case ACTIONS.ESCALATE:
        await prisma.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "conversation.escalated",
            targetType: "customer",
            targetId: customerId,
            reason: effect.reason,
          },
        });
        break;
    }
  }

  return followUps;
}

/** Serviceability for a saved address, or null when we have no pin. */
async function zoneFor(prisma: PrismaClient, addressId?: string | null) {
  if (!addressId) return null;
  const a = await prisma.customerAddress.findUnique({
    where: { id: addressId },
    select: { latitude: true, longitude: true },
  });
  if (a?.latitude == null || a.longitude == null) return null;
  return resolveDeliveryZone(prisma, Number(a.latitude), Number(a.longitude));
}

/**
 * Adding to the cart reserves stock immediately, with an expiry. If the
 * customer wanders off, the sweeper releases it - stock is never held
 * indefinitely by an abandoned conversation.
 */
async function addToCart(
  prisma: PrismaClient,
  customerId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { priceMinor: true },
    });

    const inventory = await tx.inventory.findFirst({
      where: { productId, variantId: null },
    });
    if (!inventory || inventory.onHand - inventory.reserved < quantity) {
      throw new Error(`insufficient stock for ${productId}`);
    }

    const cart =
      (await tx.cart.findFirst({ where: { customerId, status: "ACTIVE" } })) ??
      (await tx.cart.create({
        data: {
          customerId,
          status: "ACTIVE",
          expiresAt: new Date(Date.now() + 24 * 3600_000),
        },
      }));

    const existing = await tx.cartItem.findFirst({
      where: { cartId: cart.id, productId, variantId: null },
    });

    if (existing) {
      await tx.cartItem.update({
        where: { id: existing.id },
        data: { quantity: { increment: quantity } },
      });
    } else {
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          quantity,
          unitPriceMinor: product.priceMinor,
        },
      });
    }

    await tx.inventory.update({
      where: { id: inventory.id },
      data: { reserved: { increment: quantity } },
    });

    await tx.inventoryReservation.create({
      data: {
        inventoryId: inventory.id,
        cartId: cart.id,
        quantity,
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MIN * 60_000),
      },
    });
  });
}

async function clearCart(prisma: PrismaClient, customerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const cart = await tx.cart.findFirst({
      where: { customerId, status: "ACTIVE" },
      include: { reservations: { where: { releasedAt: null } } },
    });
    if (!cart) return;

    // Put the held stock back before dropping the cart.
    for (const r of cart.reservations) {
      await tx.inventory.update({
        where: { id: r.inventoryId },
        data: { reserved: { decrement: r.quantity } },
      });
    }
    await tx.inventoryReservation.updateMany({
      where: { cartId: cart.id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.cart.update({ where: { id: cart.id }, data: { status: "ABANDONED" } });
  });
}

/**
 * Stores the pin and keeps the PostGIS point in sync. Prisma cannot write the
 * geography column directly, so it is set with raw SQL in the same breath.
 */
async function saveLocation(
  prisma: PrismaClient,
  customerId: string,
  effect: Extract<Effect, { type: typeof ACTIONS.SAVE_LOCATION }>,
): Promise<string> {
  const address = await prisma.customerAddress.create({
    data: {
      customerId,
      line1: effect.address ?? effect.name ?? "Shared location",
      latitude: effect.latitude,
      longitude: effect.longitude,
      source: "PIN",
      isDefault: true,
    },
    select: { id: true },
  });

  await prisma.$executeRawUnsafe(
    `UPDATE customer_addresses
        SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      WHERE id = $3`,
    effect.longitude,
    effect.latitude,
    address.id,
  );

  return address.id;
}

function log(msg: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}
