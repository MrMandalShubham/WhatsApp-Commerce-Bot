import { formatMinor } from "./money";

// ---------------------------------------------------------------------------
// Rider cash
// ---------------------------------------------------------------------------

/**
 * With own riders there is no courier holding COD float for us - cash moves
 * through individual people, daily. A rider carrying too much undeposited cash
 * stops being assigned COD work until they settle up.
 */
export interface CashPosition {
  outstandingMinor: number;
  ceilingMinor: number;
}

export interface CashCheck {
  allowed: boolean;
  message?: string;
  wouldHoldMinor: number;
}

export function canCarryCod(
  position: CashPosition,
  orderTotalMinor: number,
  currency = "INR",
): CashCheck {
  const wouldHoldMinor = position.outstandingMinor + orderTotalMinor;
  if (wouldHoldMinor > position.ceilingMinor) {
    return {
      allowed: false,
      wouldHoldMinor,
      message:
        `Rider would hold ${formatMinor(wouldHoldMinor, currency)}, over the ` +
        `${formatMinor(position.ceilingMinor, currency)} limit. Settle cash first.`,
    };
  }
  return { allowed: true, wouldHoldMinor };
}

export interface SettlementLine {
  amountDueMinor: number;
  amountCollectedMinor: number;
}

/**
 * What the rider owes the shop, and whether the count came up short.
 *
 * Shortfall is recorded rather than absorbed: partial payments and "the
 * customer only had 500" are routine, and the difference has to be visible.
 */
export function summariseSettlement(lines: SettlementLine[]): {
  expectedMinor: number;
  collectedMinor: number;
  shortfallMinor: number;
} {
  const expectedMinor = lines.reduce((s, l) => s + l.amountDueMinor, 0);
  const collectedMinor = lines.reduce((s, l) => s + l.amountCollectedMinor, 0);
  return {
    expectedMinor,
    collectedMinor,
    shortfallMinor: Math.max(0, expectedMinor - collectedMinor),
  };
}

// ---------------------------------------------------------------------------
// Geometry and ETA
// ---------------------------------------------------------------------------

/** Great-circle distance in metres. */
export function haversineMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/**
 * Straight-line distance inflated by a road factor. Deliberately rough - an
 * honest "about 12 minutes" beats a precise number computed from a routing
 * API we are not paying for.
 */
export function etaMinutes(
  distanceMetres: number,
  opts: { avgSpeedKmh?: number; roadFactor?: number; handoverMinutes?: number } = {},
): number {
  const speed = opts.avgSpeedKmh ?? 18; // city two-wheeler, with traffic
  const road = opts.roadFactor ?? 1.35;
  const handover = opts.handoverMinutes ?? 3;
  const km = (distanceMetres / 1000) * road;
  return Math.max(1, Math.round((km / speed) * 60 + handover));
}

/** A position older than this must not be drawn as the rider's current spot. */
export const POSITION_STALE_AFTER_MS = 90_000;

export function isPositionStale(recordedAt: Date, now = new Date()): boolean {
  return now.getTime() - recordedAt.getTime() > POSITION_STALE_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Customer-facing copy
// ---------------------------------------------------------------------------

export function renderOutForDelivery(params: {
  orderNumber: string;
  riderName: string;
  etaMinutes: number | null;
  trackingUrl: string;
}): string {
  const eta = params.etaMinutes
    ? ` · arriving in about ${params.etaMinutes} minutes`
    : "";
  return [
    `Your order *${params.orderNumber}* is out for delivery.`,
    `${params.riderName} is on the way${eta}.`,
    "",
    `Track live: ${params.trackingUrl}`,
  ].join("\n");
}

export function renderDelivered(
  orderNumber: string,
  codCollectedMinor?: number,
  currency = "INR",
): string {
  const lines = [`Order *${orderNumber}* delivered. Thank you!`];
  if (codCollectedMinor && codCollectedMinor > 0) {
    lines.push("", `Cash received: ${formatMinor(codCollectedMinor, currency)}`);
  }
  lines.push("", "Reply *menu* to order again.");
  return lines.join("\n");
}

export function renderDeliveryFailed(orderNumber: string, reason?: string | null): string {
  return [
    `We could not deliver *${orderNumber}* today.`,
    reason ? `Reason: ${reason}` : "",
    "",
    "Our team will contact you to arrange another attempt.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderPacked(orderNumber: string): string {
  return `Order *${orderNumber}* is packed and ready. We'll let you know when it leaves for delivery.`;
}
