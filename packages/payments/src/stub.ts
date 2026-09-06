import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CreateLinkParams, PaymentEvent, PaymentLink, PaymentProvider,
} from "./types";

/**
 * Local development without Razorpay credentials. Produces a deterministic
 * fake link and signs webhooks with a known secret, so the whole payment
 * reconciliation path can be tested before the merchant account exists.
 */
export class StubPaymentProvider implements PaymentProvider {
  constructor(private readonly secret = "stub_webhook_secret", private readonly baseUrl = "https://pay.example.test") {}

  async createLink(p: CreateLinkParams): Promise<PaymentLink> {
    const id = `plink_stub_${p.referenceId.replace(/\W/g, "")}`;
    return {
      providerLinkId: id,
      url: `${this.baseUrl}/${id}`,
      expiresAt: new Date(Date.now() + p.expiresInMinutes * 60_000),
      stubbed: true,
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", this.secret).update(rawBody).digest();
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
    const p = payload as {
      id?: string; event?: string;
      payload?: { payment_link?: { entity?: { id?: string; reference_id?: string; amount?: number } } };
    };
    const e = p?.payload?.payment_link?.entity;
    return {
      kind:
        p?.event === "payment_link.paid" ? "paid"
        : p?.event === "payment_link.expired" ? "expired"
        : p?.event === "payment.failed" ? "failed"
        : "unknown",
      referenceId: e?.reference_id ?? null,
      providerLinkId: e?.id ?? null,
      providerPaymentId: `pay_stub_${Date.now()}`,
      amountMinor: e?.amount ?? null,
      eventId: p?.id ?? null,
    };
  }
}
