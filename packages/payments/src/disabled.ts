import { PaymentError, type PaymentEvent, type PaymentLink, type PaymentProvider } from "./types";

/**
 * Used in production when no gateway is configured.
 *
 * Every operation fails loudly rather than pretending to work. Issuing a fake
 * payment link to a real customer would take their order and collect nothing,
 * which is far worse than the order simply not being placeable online.
 */
export class DisabledPaymentProvider implements PaymentProvider {
  async createLink(): Promise<PaymentLink> {
    throw new PaymentError(
      "Online payment is not configured for this shop. Take the order as cash on delivery.",
      503,
      false,
    );
  }

  /** No secret to check against, so nothing can be trusted. */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): PaymentEvent {
    return {
      kind: "unknown",
      referenceId: null,
      providerLinkId: null,
      providerPaymentId: null,
      amountMinor: null,
      eventId: null,
    };
  }
}
