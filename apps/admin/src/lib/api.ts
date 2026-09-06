"use client";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const KEY = "wcb.admin.token";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const getToken = (): string | null => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};
export const setToken = (t: string | null): void => {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* ignore */ }
};

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void): void => { onUnauthorized = fn; };

export async function call<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  if (auth) {
    const t = getToken();
    if (!t) throw new ApiError("not signed in", 401);
    headers.set("Authorization", `Bearer ${t}`);
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...rest, headers, cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the API. Is it running?", 0);
  }

  if (res.status === 401) {
    setToken(null);
    onUnauthorized?.();
    throw new ApiError("Session expired", 401);
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  if (!res.ok) {
    const m = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new ApiError(m ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export const post = <T,>(p: string, b?: unknown) =>
  call<T>(p, { method: "POST", body: JSON.stringify(b ?? {}) });
export const patch = <T,>(p: string, b: unknown) =>
  call<T>(p, { method: "PATCH", body: JSON.stringify(b) });
export const del = <T,>(p: string) => call<T>(p, { method: "DELETE" });

export const rupees = (m: number): string =>
  `₹${(m / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

/* ---- shapes we actually use ---- */
export interface Overview {
  today: { orders: number; revenueMinor: number };
  period: { orders: number; revenueMinor: number; averageOrderMinor: number };
  fulfillment: Record<string, number>;
  payment: Record<string, number>;
  attention: {
    awaitingPayment: number; failedPayments: number; ridersOnTrip: number;
    stuckWebhooks: number; failedMessageSends: number; lowStockProducts: number;
  };
}
export interface OrderRow {
  id: string; orderNumber: string;
  customer: { waPhone: string; name: string | null };
  paymentMode: string; paymentStatus: string; fulfillmentStatus: string;
  orderStatus: string; displayStatus: string; totalMinor: number;
  itemCount: number; rider: { id: string; name: string } | null; placedAt: string | null;
}
export interface RiderRow {
  id: string; name: string; delivered: number; failed: number;
  successRate: number | null; cashOutstandingMinor: number;
  cashCeilingMinor: number; overCeiling: boolean;
}
export interface ProductRow {
  id: string; sku: string; title: string; priceMinor: number; gstRate: number;
  isActive: boolean; category: { name: string } | null;
  stock: { onHand: number; reserved: number; available: number } | null;
}
