import { z } from "zod";

/**
 * Fail fast on boot rather than at 2am when a template send needs a token.
 * Provider secrets are optional in development so the stack starts without a
 * Meta account, but the app refuses to boot without them in production.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),

  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_API_VERSION: z.string().default("v21.0"),

  RAZORPAY_KEY_ID: z.string().default(""),
  RAZORPAY_KEY_SECRET: z.string().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(""),

  GEO_PROVIDER: z.enum(["google", "mapbox"]).default("google"),
  GOOGLE_MAPS_SERVER_KEY: z.string().default(""),

  JWT_SECRET: z.string().min(16),
  TRACKING_TOKEN_SECRET: z.string().min(16),

  DEFAULT_CURRENCY: z.string().default("INR"),
  RESERVATION_TTL_MINUTES: z.coerce.number().default(30),
  SESSION_TTL_MINUTES: z.coerce.number().default(30),
  CART_ABANDON_HOURS: z.coerce.number().default(24),
  RIDER_PING_RETENTION_DAYS: z.coerce.number().default(30),
  WEBHOOK_EVENT_RETENTION_DAYS: z.coerce.number().default(90),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/** Without these nothing works at all - no messages in or out. */
const REQUIRED_IN_PROD = [
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
] as const;

/**
 * Razorpay is deliberately NOT required to boot.
 *
 * Merchant KYC takes weeks, and a shop can trade cash-on-delivery only in the
 * meantime. Blocking startup would mean the whole platform waits on a bank
 * approval. Instead the shop runs COD-only and the chat flow simply does not
 * offer online payment - see onlinePaymentsEnabled.
 */
export const onlinePaymentsEnabled = Boolean(
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET,
);

if (env.NODE_ENV === "production") {
  const missing = REQUIRED_IN_PROD.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing production secrets: ${missing.join(", ")}`);
  }
  if (!onlinePaymentsEnabled) {
    console.warn(
      "[config] Razorpay is not configured - running CASH ON DELIVERY ONLY. " +
        "Online payment will not be offered to customers.",
    );
  }
}
