import { RazorpayProvider, type RazorpayConfig } from "./razorpay";
import { StubPaymentProvider } from "./stub";
import type { PaymentProvider } from "./types";

export * from "./types";
export * from "./razorpay";
export * from "./stub";

export function createPaymentProvider(cfg: Partial<RazorpayConfig>): PaymentProvider {
  if (cfg.keyId && cfg.keySecret && cfg.webhookSecret) {
    return new RazorpayProvider(cfg as RazorpayConfig);
  }
  console.warn(
    "[payments] Razorpay not configured - using StubPaymentProvider (no real charges)",
  );
  return new StubPaymentProvider(cfg.webhookSecret || undefined);
}
