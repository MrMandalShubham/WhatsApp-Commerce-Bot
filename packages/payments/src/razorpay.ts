import { createHmac, timingSafeEqual } from "node:crypto";

import {
  PaymentError,
  type CreateLinkParams,
  type PaymentEvent,
  type PaymentLink,
  type PaymentProvider,
} from "./types";

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
}

export class RazorpayProvider implements PaymentProvider {
  private readonly base: string;

  constructor(private readonly cfg: RazorpayConfig) {
    this.base = cfg.baseUrl ?? "https://api.razorpay.com/v1";
  }

  async createLink(p: CreateLinkParams): Promise<PaymentLink> {
    const expiresAt = new Date(Date.now() + p.expiresInMinutes * 60_000);

    const body = {
      amount: p.amountMinor,
      currency: p.currency,
      description: p.description,
      reference_id: p.referenceId,
      // Razorpay requires expire_by to be at least 15 minutes out.
      expire_by: Math.floor(expiresAt.getTime() / 1000),
      customer: {
        name: p.customerName ?? undefined,
        contact: p.customerPhone,
      },
      notify: { sms: false, email: false }, // we notify on WhatsApp ourselves
      reminder_enable: false,
      ...(p.callbackUrl ? { callback_url: p.callbackUrl, callback_method: "get" } : {}),
    };

    const res = await fetch(`${this.base}/payment_links`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as RazorpayLinkResponse;
    if (!res.ok) {
      throw new PaymentError(
        json?.error?.description ?? `payment link creation failed (${res.status})`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }

    return {
      providerLinkId: json.id ?? "",
      url: json.short_url ?? "",
      expiresAt,
      stubbed: false,
    };
  }

  /**
   * Razorpay signs the raw body with the webhook secret. Compared in constant
   * time; a length mismatch short-circuits before timingSafeEqual, which
   * throws on unequal buffers.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.cfg.webhookSecret) return false;
    const expected = createHmac("sha256", this.cfg.webhookSecret).update(rawBody).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "hex");
    } catch {
      return false;
    }
    if (received.length !== expected.length) return false;
    return timingSafeEqual(expected, received);
  }

  parseWebhook(payload: unknown): PaymentEvent {
    const p = payload as RazorpayWebhook;
    const link = p?.payload?.payment_link?.entity;
    const payment = p?.payload?.payment?.entity;

    return {
      kind: mapEvent(p?.event),
      referenceId: link?.reference_id ?? payment?.notes?.reference_id ?? null,
      providerLinkId: link?.id ?? null,
      providerPaymentId: payment?.id ?? null,
      amountMinor: payment?.amount ?? link?.amount ?? null,
      eventId: p?.id ?? null,
    };
  }
}

function mapEvent(event?: string): PaymentEvent["kind"] {
  switch (event) {
    case "payment_link.paid":
    case "payment.captured":
      return "paid";
    case "payment_link.expired":
      return "expired";
    case "payment.failed":
      return "failed";
    case "refund.processed":
      return "refunded";
    default:
      return "unknown";
  }
}

interface RazorpayLinkResponse {
  id?: string;
  short_url?: string;
  error?: { description?: string };
}

interface RazorpayWebhook {
  id?: string;
  event?: string;
  payload?: {
    payment_link?: { entity?: { id?: string; reference_id?: string; amount?: number } };
    payment?: { entity?: { id?: string; amount?: number; notes?: { reference_id?: string } } };
  };
}
