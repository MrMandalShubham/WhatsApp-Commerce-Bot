import { RazorpayProvider, type RazorpayConfig } from "./razorpay";
import { StubPaymentProvider } from "./stub";
import { DisabledPaymentProvider } from "./disabled";
import type { PaymentProvider } from "./types";

export * from "./types";
export * from "./razorpay";
export * from "./stub";
export * from "./disabled";

export function createPaymentProvider(cfg: Partial<RazorpayConfig>): PaymentProvider {
  if (cfg.keyId && cfg.keySecret && cfg.webhookSecret) {
    return new RazorpayProvider(cfg as RazorpayConfig);
  }

  // A stub issues links that look real and collect nothing. Handing one to a
  // customer in production would be worse than any error, so refuse instead.
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[payments] Razorpay not configured - online payment is DISABLED. " +
        "The shop can still take cash on delivery.",
    );
    return new DisabledPaymentProvider();
  }

  console.warn(
    "[payments] Razorpay not configured - using StubPaymentProvider (no real charges)",
  );
  return new StubPaymentProvider(cfg.webhookSecret || undefined);
}
