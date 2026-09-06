export interface CreateLinkParams {
  /** Our order number - echoed back on the webhook as reference_id. */
  referenceId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerName?: string;
  /** E.164 without the leading +, as Razorpay expects. */
  customerPhone: string;
  expiresInMinutes: number;
  callbackUrl?: string;
}

export interface PaymentLink {
  providerLinkId: string;
  url: string;
  expiresAt: Date;
  stubbed: boolean;
}

export type PaymentEventKind =
  | "paid"
  | "failed"
  | "expired"
  | "refunded"
  | "unknown";

export interface PaymentEvent {
  kind: PaymentEventKind;
  /** Our order number, from reference_id. */
  referenceId: string | null;
  providerLinkId: string | null;
  providerPaymentId: string | null;
  amountMinor: number | null;
  /** Provider's own event id, used for idempotency. */
  eventId: string | null;
}

/**
 * No business logic imports a gateway SDK. Swapping Razorpay for PayU means
 * one more implementation of this and nothing else.
 */
export interface PaymentProvider {
  createLink(params: CreateLinkParams): Promise<PaymentLink>;
  /** Constant-time HMAC check over the RAW request body. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(payload: unknown): PaymentEvent;
}

export class PaymentError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "PaymentError";
  }
}
