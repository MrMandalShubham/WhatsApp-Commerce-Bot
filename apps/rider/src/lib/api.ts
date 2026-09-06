"use client";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
const TOKEN_KEY = "wcb.rider.token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** localStorage throws in some privacy modes; never let that break the app. */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");

  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError("not signed in", 401);
    headers.set("Authorization", `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...rest, headers });
  } catch {
    // Distinguish "the network is down" from "the server said no" - the rider
    // needs to know whether to retry or to call the shop.
    throw new ApiError("No connection. Check your signal and try again.", 0);
  }

  if (res.status === 401) {
    setToken(null);
    throw new ApiError("Session expired. Please sign in again.", 401);
  }

  const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  if (!res.ok) {
    const msg = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new ApiError(msg ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ accessToken: string; user: { name: string; role: string } }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }), auth: false },
    ),

  me: () => request<{ sub: string; email: string; role: string }>("/auth/me"),

  assignments: () => request<Assignment[]>("/rider/assignments"),

  cash: () => request<CashSummary>("/rider/cash"),

  start: (deliveryId: string, pos?: { latitude: number; longitude: number }) =>
    request<{ status: string; trackingToken: string }>(
      `/rider/assignments/${deliveryId}/start`,
      { method: "POST", body: JSON.stringify(pos ?? {}) },
    ),

  ping: (body: {
    latitude: number;
    longitude: number;
    accuracyM?: number;
    deliveryId?: string;
  }) => request<{ ok: true }>("/rider/location", { method: "POST", body: JSON.stringify(body) }),

  complete: (deliveryId: string, body: CompleteBody) =>
    request<{ status: string }>(`/rider/assignments/${deliveryId}/complete`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export interface Assignment {
  deliveryId: string;
  status: "ASSIGNED" | "PICKED_UP" | "OUT_FOR_DELIVERY";
  order: {
    orderNumber: string;
    totalMinor: number;
    paymentMode: "COD" | "ONLINE";
    collectCashMinor: number;
    items: Array<{ titleSnapshot: string; quantity: number }>;
  };
  customer: { name: string | null; phoneMasked: string };
  address: {
    line1: string;
    landmark: string | null;
    latitude: string | number | null;
    longitude: string | number | null;
    mapsUrl: string | null;
  } | null;
}

export interface CashSummary {
  expectedMinor: number;
  collectedMinor: number;
  shortfallMinor: number;
  ceilingMinor: number;
  openCollections: number;
  overCeiling: boolean;
}

export interface CompleteBody {
  outcome: "DELIVERED" | "FAILED";
  amountCollectedMinor?: number;
  podType?: "NONE" | "PHOTO" | "OTP" | "SIGNATURE";
  recipientName?: string;
  note?: string;
}

export const rupees = (minor: number): string =>
  `₹${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

export const toMinor = (rupeeText: string): number | null => {
  const cleaned = rupeeText.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};
