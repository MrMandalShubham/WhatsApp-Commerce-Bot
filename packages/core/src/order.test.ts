import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IllegalTransitionError, assertTransition, buildOrderLines, canTransition,
  checkCodEligibility, checkOrderable, displayStatus, formatOrderNumber,
  type DeliveryZone,
} from "./order";

const zone = (o: Partial<DeliveryZone> = {}): DeliveryZone => ({
  serviceable: true, codAllowed: true, codMaxOrderMinor: 500000,
  deliveryFeeMinor: 3000, minOrderValueMinor: 20000, ...o,
});

test("COD is allowed inside the zone, under the ceiling, above the minimum", () => {
  assert.equal(checkCodEligibility(100000, zone()).allowed, true);
});

test("an unserviceable pin blocks COD and names why", () => {
  const r = checkCodEligibility(100000, zone({ serviceable: false }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "not_serviceable");
});

test("an order above the COD ceiling is pushed to online payment", () => {
  const r = checkCodEligibility(600000, zone());
  assert.equal(r.reason, "above_cod_ceiling");
  assert.match(r.message ?? "", /5000\.00/);
});

test("a null COD ceiling means no ceiling", () => {
  assert.equal(checkCodEligibility(9_999_999, zone({ codMaxOrderMinor: null })).allowed, true);
});

test("below the minimum order value blocks every payment method", () => {
  assert.equal(checkCodEligibility(10000, zone()).reason, "below_minimum_order");
  assert.equal(checkOrderable(10000, zone()).reason, "below_minimum_order");
});

test("a zone with COD disabled still accepts online orders", () => {
  const z = zone({ codAllowed: false });
  assert.equal(checkCodEligibility(100000, z).reason, "cod_disabled_in_area");
  assert.equal(checkOrderable(100000, z).allowed, true);
});

test("the cheapest blocker is reported first", () => {
  // Both below minimum AND above ceiling is impossible, but unserviceable
  // must win over everything else.
  const r = checkCodEligibility(10000, zone({ serviceable: false }));
  assert.equal(r.reason, "not_serviceable");
});

test("order lines snapshot title, sku, hsn, price and tax", () => {
  const { lines, totals } = buildOrderLines([
    { productId: "p1", sku: "A-1", hsnCode: "1101", title: "Atta 5 kg",
      unitPriceMinor: 27500, quantity: 2, gstRatePercent: 5 },
    { productId: "p2", sku: "B-1", hsnCode: "1905", title: "Biscuits",
      unitPriceMinor: 4000, quantity: 3, gstRatePercent: 18 },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].skuSnapshot, "A-1");
  assert.equal(lines[0].hsnSnapshot, "1101");
  assert.equal(lines[0].lineTotalMinor, 55000);
  assert.equal(lines[1].taxMinor, 1831);
  assert.equal(totals.totalMinor, 67000);
});

test("a COD order may go straight from not_required to paid on delivery", () => {
  assert.equal(canTransition("payment", "NOT_REQUIRED", "PAID"), true);
});

test("a paid order cannot silently become unpaid", () => {
  assert.equal(canTransition("payment", "PAID", "PENDING"), false);
  assert.equal(canTransition("payment", "PAID", "FAILED"), false);
});

test("a refunded payment is terminal", () => {
  assert.equal(canTransition("payment", "REFUNDED", "PAID"), false);
});

test("re-issuing a link is a new attempt, not a status transition", () => {
  // Staff can re-send a payment link any number of times; the status stays
  // LINK_SENT and a fresh Payment row records the attempt.
  assert.equal(canTransition("payment", "LINK_SENT", "LINK_SENT"), false);
  assert.equal(canTransition("payment", "PENDING", "PENDING"), false);
  assert.equal(canTransition("payment", "EXPIRED", "LINK_SENT"), true);
});

test("fulfilment cannot skip from unfulfilled to delivered", () => {
  assert.equal(canTransition("fulfillment", "UNFULFILLED", "DELIVERED"), false);
});

test("a failed delivery can be retried", () => {
  assert.equal(canTransition("fulfillment", "FAILED_DELIVERY", "ASSIGNED"), true);
});

test("a completed order cannot be reopened", () => {
  assert.equal(canTransition("order", "COMPLETED", "CONFIRMED"), false);
  assert.equal(canTransition("order", "CANCELLED", "PLACED"), false);
});

test("assertTransition raises rather than silently no-opping", () => {
  assert.throws(() => assertTransition("payment", "PAID", "PENDING"), IllegalTransitionError);
  assert.doesNotThrow(() => assertTransition("payment", "PENDING", "PAID"));
});

test("display status is derived, and fulfilment outranks payment", () => {
  // A COD order that has shipped but not yet been paid must not read
  // "Awaiting payment" to the customer.
  assert.equal(displayStatus("NOT_REQUIRED", "OUT_FOR_DELIVERY", "CONFIRMED"), "Out for delivery");
  assert.equal(displayStatus("PENDING", "UNFULFILLED", "PLACED"), "Awaiting payment");
  assert.equal(displayStatus("PAID", "DELIVERED", "COMPLETED"), "Delivered");
  assert.equal(displayStatus("PAID", "UNFULFILLED", "CANCELLED"), "Cancelled");
});

test("order numbers are zero padded and stable", () => {
  assert.equal(formatOrderNumber(1), "WCB-000001");
  assert.equal(formatOrderNumber(123456), "WCB-123456");
});
