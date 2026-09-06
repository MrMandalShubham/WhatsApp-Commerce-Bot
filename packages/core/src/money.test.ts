import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMinor, parseToMinor, splitCgstSgst, splitInclusiveGst } from "./money";
import { computeTotals, renderCart } from "./cart";

test("GST split always sums back to the inclusive price", () => {
  for (const amount of [27500, 4000, 3000, 1, 999999, 15500]) {
    for (const rate of [0, 5, 12, 18, 28]) {
      const s = splitInclusiveGst(amount, rate);
      assert.equal(s.taxableMinor + s.taxMinor, amount, `${amount}@${rate}%`);
      assert.equal(s.totalMinor, amount);
      assert.ok(Number.isInteger(s.taxMinor));
    }
  }
});

test("18% GST on Rs 40.00 inclusive extracts Rs 6.10", () => {
  const s = splitInclusiveGst(4000, 18);
  assert.equal(s.taxMinor, 610);
  assert.equal(s.taxableMinor, 3390);
});

test("zero-rated goods carry no tax", () => {
  const s = splitInclusiveGst(10000, 0);
  assert.equal(s.taxMinor, 0);
  assert.equal(s.taxableMinor, 10000);
});

test("CGST and SGST halves never lose a paisa", () => {
  for (const tax of [610, 611, 1, 0, 12345]) {
    const { cgstMinor, sgstMinor } = splitCgstSgst(tax);
    assert.equal(cgstMinor + sgstMinor, tax);
  }
});

test("rejects non-integer amounts rather than rounding silently", () => {
  assert.throws(() => splitInclusiveGst(100.5, 18), TypeError);
});

test("mixed GST rates are taxed per line, not blended", () => {
  const totals = computeTotals([
    { title: "Atta 5 kg", unitPriceMinor: 27500, quantity: 2, gstRatePercent: 5 },
    { title: "Biscuits", unitPriceMinor: 4000, quantity: 3, gstRatePercent: 18 },
  ]);
  assert.equal(totals.itemCount, 5);
  // 55000 @5% -> 2619 ; 12000 @18% -> 1831
  assert.equal(totals.taxMinor, 2619 + 1831);
  assert.equal(totals.subtotalMinor + totals.taxMinor, 55000 + 12000);
  assert.equal(totals.totalMinor, 67000);
});

test("delivery fee is added on top of the taxed total", () => {
  const totals = computeTotals(
    [{ title: "Oil", unitPriceMinor: 15500, quantity: 1, gstRatePercent: 5 }],
    3000,
  );
  assert.equal(totals.totalMinor, 15500 + 3000);
});

test("rejects a zero or fractional quantity", () => {
  const line = { title: "x", unitPriceMinor: 100, gstRatePercent: 5 };
  assert.throws(() => computeTotals([{ ...line, quantity: 0 }]), RangeError);
  assert.throws(() => computeTotals([{ ...line, quantity: 1.5 }]), RangeError);
});

test("formats and parses rupee amounts", () => {
  assert.equal(formatMinor(27500), "\u20B9275.00");
  assert.equal(formatMinor(5), "\u20B90.05");
  assert.equal(parseToMinor("275"), 27500);
  assert.equal(parseToMinor("\u20B92.50"), 250);
  assert.equal(parseToMinor("abc"), null);
});

test("empty cart renders a friendly message", () => {
  assert.match(renderCart(computeTotals([])), /empty/i);
});
