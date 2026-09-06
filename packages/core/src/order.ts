import { computeTotals, renderCart, type CartLineInput, type CartTotals } from "./cart";
import { formatMinor } from "./money";

// ---------------------------------------------------------------------------
// Serviceability and COD eligibility
// ---------------------------------------------------------------------------

export interface DeliveryZone {
  serviceable: boolean;
  areaName?: string;
  codAllowed: boolean;
  /** Null means no ceiling for this zone. */
  codMaxOrderMinor?: number | null;
  deliveryFeeMinor: number;
  minOrderValueMinor: number;
}

export type CodRejection =
  | "not_serviceable"
  | "cod_disabled_in_area"
  | "above_cod_ceiling"
  | "below_minimum_order";

export interface Eligibility {
  allowed: boolean;
  reason?: CodRejection;
  message?: string;
}

/**
 * Whether this order may be placed as cash on delivery.
 *
 * Deliberately pure and total: every rejection carries a machine-readable
 * reason and a sentence the customer can actually act on. The rules are
 * checked cheapest-first so the message names the real blocker.
 */
export function checkCodEligibility(
  totalMinor: number,
  zone: DeliveryZone,
  currency = "INR",
): Eligibility {
  if (!zone.serviceable) {
    return {
      allowed: false,
      reason: "not_serviceable",
      message: "We do not deliver to this location yet.",
    };
  }
  if (totalMinor < zone.minOrderValueMinor) {
    return {
      allowed: false,
      reason: "below_minimum_order",
      message: `Minimum order for delivery is ${formatMinor(zone.minOrderValueMinor, currency)}.`,
    };
  }
  if (!zone.codAllowed) {
    return {
      allowed: false,
      reason: "cod_disabled_in_area",
      message: "Cash on delivery is not available in this area — please pay online.",
    };
  }
  if (zone.codMaxOrderMinor != null && totalMinor > zone.codMaxOrderMinor) {
    return {
      allowed: false,
      reason: "above_cod_ceiling",
      message: `Cash on delivery is available up to ${formatMinor(zone.codMaxOrderMinor, currency)}. Please pay online for this order.`,
    };
  }
  return { allowed: true };
}

/** Whether the order can be placed at all, by any payment method. */
export function checkOrderable(totalMinor: number, zone: DeliveryZone, currency = "INR"): Eligibility {
  if (!zone.serviceable) {
    return {
      allowed: false,
      reason: "not_serviceable",
      message: "We do not deliver to this location yet.",
    };
  }
  if (totalMinor < zone.minOrderValueMinor) {
    return {
      allowed: false,
      reason: "below_minimum_order",
      message: `Minimum order for delivery is ${formatMinor(zone.minOrderValueMinor, currency)}.`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export type PaymentStatus =
  | "NOT_REQUIRED" | "PENDING" | "LINK_SENT" | "PAID"
  | "FAILED" | "EXPIRED" | "REFUND_PENDING" | "REFUNDED";

export type FulfillmentStatus =
  | "UNFULFILLED" | "CONFIRMED" | "PACKED" | "ASSIGNED"
  | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED_DELIVERY" | "RETURNED";

export type OrderStatus = "DRAFT" | "PLACED" | "CONFIRMED" | "COMPLETED" | "CANCELLED";

/**
 * Guarded transitions. An illegal move raises rather than silently no-opping,
 * which is what keeps a courier callback arriving before a payment sync from
 * corrupting the order.
 */
const PAYMENT: Record<PaymentStatus, PaymentStatus[]> = {
  NOT_REQUIRED: ["PAID", "REFUND_PENDING"],       // COD collected on delivery
  PENDING: ["LINK_SENT", "PAID", "FAILED", "EXPIRED"],
  // Re-issuing a link is NOT a status transition: it creates a new payment
  // attempt row while the status stays LINK_SENT.
  LINK_SENT: ["PAID", "FAILED", "EXPIRED"],
  PAID: ["REFUND_PENDING"],
  FAILED: ["LINK_SENT", "PENDING", "EXPIRED"],
  EXPIRED: ["LINK_SENT", "PENDING"],
  REFUND_PENDING: ["REFUNDED", "PAID"],
  REFUNDED: [],
};

const FULFILLMENT: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  UNFULFILLED: ["CONFIRMED", "RETURNED"],
  CONFIRMED: ["PACKED", "RETURNED"],
  PACKED: ["ASSIGNED", "RETURNED"],
  ASSIGNED: ["OUT_FOR_DELIVERY", "PACKED", "RETURNED"], // reassignment
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  FAILED_DELIVERY: ["ASSIGNED", "OUT_FOR_DELIVERY", "RETURNED"], // retry
  DELIVERED: ["RETURNED"],
  RETURNED: [],
};

const ORDER: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ["PLACED", "CANCELLED"],
  PLACED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const MACHINES = { payment: PAYMENT, fulfillment: FULFILLMENT, order: ORDER } as const;
export type StatusField = keyof typeof MACHINES;

export function canTransition(field: StatusField, from: string, to: string): boolean {
  if (from === to) return false;
  const allowed = (MACHINES[field] as Record<string, string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(readonly field: StatusField, readonly from: string, readonly to: string) {
    super(`illegal ${field} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(field: StatusField, from: string, to: string): void {
  if (!canTransition(field, from, to)) throw new IllegalTransitionError(field, from, to);
}

/**
 * The label the customer sees is DERIVED from the three fields - never stored
 * as a fourth source of truth.
 */
export function displayStatus(
  payment: PaymentStatus,
  fulfillment: FulfillmentStatus,
  order: OrderStatus,
): string {
  if (order === "CANCELLED") return "Cancelled";
  if (payment === "REFUNDED") return "Refunded";
  if (fulfillment === "RETURNED") return "Returned";
  if (fulfillment === "DELIVERED") return "Delivered";
  if (fulfillment === "FAILED_DELIVERY") return "Delivery attempt failed";
  if (fulfillment === "OUT_FOR_DELIVERY") return "Out for delivery";
  if (fulfillment === "ASSIGNED") return "Ready for delivery";
  if (fulfillment === "PACKED") return "Packed";
  if (payment === "LINK_SENT" || payment === "PENDING") return "Awaiting payment";
  if (payment === "FAILED") return "Payment failed";
  if (payment === "EXPIRED") return "Payment link expired";
  if (fulfillment === "CONFIRMED" || order === "CONFIRMED") return "Confirmed";
  return "Received";
}

// ---------------------------------------------------------------------------
// Order construction
// ---------------------------------------------------------------------------

export interface OrderLineSnapshot {
  productId: string;
  titleSnapshot: string;
  skuSnapshot: string;
  hsnSnapshot: string | null;
  unitPriceMinor: number;
  quantity: number;
  gstRate: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export interface CartSource extends CartLineInput {
  productId: string;
  sku: string;
  hsnCode: string | null;
}

/**
 * Freezes the cart into order lines. Title, SKU, HSN, price and tax are all
 * copied in - a later catalogue edit must never rewrite an existing invoice.
 */
export function buildOrderLines(cart: CartSource[]): {
  lines: OrderLineSnapshot[];
  totals: CartTotals;
} {
  const totals = computeTotals(cart);
  const lines = totals.lines.map((l, i) => {
    const src = cart[i];
    return {
      productId: src.productId,
      titleSnapshot: src.title,
      skuSnapshot: src.sku,
      hsnSnapshot: src.hsnCode,
      unitPriceMinor: l.unitPriceMinor,
      quantity: l.quantity,
      gstRate: l.gstRatePercent,
      taxMinor: l.taxMinor,
      lineTotalMinor: l.lineTotalMinor,
    };
  });
  return { lines, totals };
}

/** "WCB-000123" */
export function formatOrderNumber(seq: number, prefix = "WCB"): string {
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Customer-facing copy
// ---------------------------------------------------------------------------

export function renderOrderPlaced(params: {
  orderNumber: string;
  totals: CartTotals;
  paymentMode: "COD" | "ONLINE";
  currency?: string;
  landmark?: string | null;
}): string {
  const cur = params.currency ?? "INR";
  const lines = [
    `*Order ${params.orderNumber} confirmed*`,
    "",
    renderCart(params.totals, cur),
  ];
  if (params.paymentMode === "COD") {
    lines.push(
      "",
      `Please keep ${formatMinor(params.totals.totalMinor, cur)} ready for the rider.`,
    );
  }
  lines.push("", "We'll message you here as your order moves. Reply *track* any time.");
  return lines.join("\n");
}

export function renderPaymentLink(params: {
  orderNumber: string;
  totals: CartTotals;
  url: string;
  expiresInMinutes: number;
  currency?: string;
}): string {
  const cur = params.currency ?? "INR";
  return [
    `*Order ${params.orderNumber}* — ${formatMinor(params.totals.totalMinor, cur)}`,
    "",
    "Tap to pay securely:",
    params.url,
    "",
    `This link expires in ${params.expiresInMinutes} minutes. Your items are held until then.`,
  ].join("\n");
}

export function renderPaymentReceived(orderNumber: string, totals: CartTotals, currency = "INR"): string {
  return [
    `Payment received for *${orderNumber}* — ${formatMinor(totals.totalMinor, currency)}.`,
    "",
    "Your order is confirmed and we'll start packing it now.",
  ].join("\n");
}
