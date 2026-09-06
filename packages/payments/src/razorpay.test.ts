import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { RazorpayProvider } from "./razorpay";

const provider = new RazorpayProvider({
  keyId: "rzp_test_x", keySecret: "secret", webhookSecret: "whsec",
});

const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));
const sign = (b: Buffer, secret = "whsec") =>
  createHmac("sha256", secret).update(b).digest("hex");

test("a correctly signed webhook is accepted", () => {
  assert.equal(provider.verifyWebhook(body, sign(body)), true);
});

test("a forged signature is rejected", () => {
  assert.equal(provider.verifyWebhook(body, "0".repeat(64)), false);
});

test("a signature from the wrong secret is rejected", () => {
  assert.equal(provider.verifyWebhook(body, sign(body, "wrong")), false);
});

test("a tampered body invalidates the signature", () => {
  const sig = sign(body);
  assert.equal(provider.verifyWebhook(Buffer.from('{"event":"x"}'), sig), false);
});

test("missing, short or non-hex signatures are rejected, never thrown", () => {
  assert.equal(provider.verifyWebhook(body, undefined), false);
  assert.equal(provider.verifyWebhook(body, "abc"), false);
  assert.equal(provider.verifyWebhook(body, "zzzz"), false);
});

test("a paid event maps to our order number via reference_id", () => {
  const e = provider.parseWebhook({
    id: "evt_1", event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: "plink_1", reference_id: "WCB-000007", amount: 67000 } },
      payment: { entity: { id: "pay_1", amount: 67000 } },
    },
  });
  assert.equal(e.kind, "paid");
  assert.equal(e.referenceId, "WCB-000007");
  assert.equal(e.providerPaymentId, "pay_1");
  assert.equal(e.amountMinor, 67000);
  assert.equal(e.eventId, "evt_1");
});

test("failed and expired events are distinguished", () => {
  assert.equal(provider.parseWebhook({ event: "payment.failed" }).kind, "failed");
  assert.equal(provider.parseWebhook({ event: "payment_link.expired" }).kind, "expired");
});

test("an unrecognised event is 'unknown', not silently treated as paid", () => {
  assert.equal(provider.parseWebhook({ event: "order.notified" }).kind, "unknown");
  assert.equal(provider.parseWebhook({}).kind, "unknown");
});
