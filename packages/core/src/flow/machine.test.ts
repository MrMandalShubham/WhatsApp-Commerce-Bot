import { test } from "node:test";
import assert from "node:assert/strict";

import { step } from "./machine";
import { ACTIONS, FlowState, type FlowContext, type ProductView } from "./types";
import type { DeliveryZone } from "../order";

const ZONE: DeliveryZone = {
  serviceable: true, codAllowed: true, codMaxOrderMinor: 500000,
  deliveryFeeMinor: 3000, minOrderValueMinor: 20000,
};

const PRODUCTS: ProductView[] = [
  { id: "p1", title: "Atta 5 kg", priceMinor: 27500, gstRatePercent: 5, available: 10 },
  { id: "p2", title: "Biscuits", priceMinor: 4000, gstRatePercent: 18, available: 2 },
  { id: "p3", title: "Sold out item", priceMinor: 1000, gstRatePercent: 5, available: 0 },
];

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return {
    state: FlowState.GREETING,
    shopName: "Test Shop",
    currency: "INR",
    hasOptedIn: true,
    failureCount: 0,
    pendingProductId: null,
    selectedCategoryId: null,
    cartLines: [],
    cartItemCount: 0,
    categories: [
      { id: "c1", name: "Groceries" },
      { id: "c2", name: "Empty aisle" },
    ],
    delivery: ZONE,
    productsInCategory: (id) => (id === "c1" ? PRODUCTS : []),
    findProduct: (id) => PRODUCTS.find((p) => p.id === id),
    ...over,
  };
}

const kinds = (r: ReturnType<typeof step>): string[] => r.replies.map((x) => x.kind);
const effects = (r: ReturnType<typeof step>): string[] => r.effects.map((e) => e.type);

// --- opt-in ---------------------------------------------------------------

test("a new customer is asked for consent before anything else", () => {
  const r = step({ text: "hi" }, ctx({ hasOptedIn: false }));
  assert.equal(r.state, FlowState.AWAITING_OPTIN);
  assert.deepEqual(kinds(r), ["buttons"]);
});

test("accepting consent records it with the exact wording shown", () => {
  const r = step({ replyId: "optin:yes" }, ctx({ state: FlowState.AWAITING_OPTIN, hasOptedIn: false }));
  const consent = r.effects.find((e) => e.type === ACTIONS.RECORD_CONSENT);
  assert.ok(consent && "wordingShown" in consent && consent.wordingShown.length > 0);
  assert.equal(r.state, FlowState.BROWSING_CATEGORIES);
});

test("declining consent still lets the customer browse", () => {
  const r = step({ replyId: "optin:no" }, ctx({ state: FlowState.AWAITING_OPTIN, hasOptedIn: false }));
  const consent = r.effects.find((e) => e.type === ACTIONS.RECORD_CONSENT);
  assert.ok(consent && "action" in consent && consent.action === "OPT_OUT");
  assert.equal(r.state, FlowState.BROWSING_CATEGORIES);
});

// --- browsing -------------------------------------------------------------

test("an empty category does not dead-end the conversation", () => {
  const r = step({ replyId: "cat:c2" }, ctx({ state: FlowState.BROWSING_CATEGORIES }));
  assert.equal(r.state, FlowState.BROWSING_CATEGORIES);
  assert.ok(r.replies.length >= 2, "should explain and re-offer categories");
});

test("out-of-stock products are never listed", () => {
  const r = step({ replyId: "cat:c1" }, ctx({ state: FlowState.BROWSING_CATEGORIES }));
  const list = r.replies.find((x) => x.kind === "list");
  assert.ok(list && list.kind === "list");
  const ids = list.sections.flatMap((s) => s.rows.map((x) => x.id));
  assert.ok(!ids.includes("prod:p3"), "sold-out item must not be offered");
  assert.ok(ids.includes("prod:p1"));
});

test("low stock is surfaced in the product list", () => {
  const r = step({ replyId: "cat:c1" }, ctx({ state: FlowState.BROWSING_CATEGORIES }));
  const list = r.replies.find((x) => x.kind === "list");
  assert.ok(list && list.kind === "list");
  const biscuits = list.sections[0].rows.find((x) => x.id === "prod:p2");
  assert.match(biscuits?.description ?? "", /only 2 left/);
});

// --- quantity -------------------------------------------------------------

test("quantity above available stock is refused with the real number", () => {
  const r = step(
    { text: "5" },
    ctx({ state: FlowState.AWAITING_QUANTITY, pendingProductId: "p2" }),
  );
  assert.equal(r.state, FlowState.AWAITING_QUANTITY);
  assert.match((r.replies[0] as { text: string }).text, /only have 2/);
  assert.ok(!effects(r).includes(ACTIONS.ADD_TO_CART));
});

test("a typed quantity works as well as a tapped button", () => {
  const typed = step({ text: "2" }, ctx({ state: FlowState.AWAITING_QUANTITY, pendingProductId: "p1" }));
  const tapped = step({ replyId: "qty:2" }, ctx({ state: FlowState.AWAITING_QUANTITY, pendingProductId: "p1" }));
  assert.equal(typed.state, FlowState.CART_REVIEW);
  assert.deepEqual(effects(typed), effects(tapped));
});

test("the button count never exceeds available stock", () => {
  const r = step({ replyId: "prod:p2" }, ctx({ state: FlowState.BROWSING_PRODUCTS }));
  const btn = r.replies.find((x) => x.kind === "buttons");
  assert.ok(btn && btn.kind === "buttons");
  assert.equal(btn.buttons.length, 2, "only 2 in stock, so only 2 buttons");
});

// --- cart -----------------------------------------------------------------

test("checkout asks for a location pin", () => {
  const r = step(
    { replyId: "cart:checkout" },
    ctx({
      state: FlowState.CART_REVIEW,
      cartLines: [{ title: "Atta", unitPriceMinor: 27500, quantity: 1, gstRatePercent: 5 }],
    }),
  );
  assert.equal(r.state, FlowState.AWAITING_LOCATION);
  assert.deepEqual(kinds(r), ["location_request"]);
});

test("checkout with an empty cart returns to the cart, not to location", () => {
  const r = step({ replyId: "cart:checkout" }, ctx({ state: FlowState.CART_REVIEW }));
  assert.notEqual(r.state, FlowState.AWAITING_LOCATION);
});

test("'cart' works as a command from any state", () => {
  const r = step(
    { text: "cart" },
    ctx({
      state: FlowState.BROWSING_PRODUCTS,
      cartLines: [{ title: "Atta", unitPriceMinor: 27500, quantity: 2, gstRatePercent: 5 }],
    }),
  );
  assert.equal(r.state, FlowState.CART_REVIEW);
  assert.match((r.replies[0] as { text: string }).text, /550\.00/);
});

// --- location -------------------------------------------------------------

test("a shared pin is saved and the flow asks for a landmark", () => {
  const r = step(
    { location: { latitude: 12.97, longitude: 77.6, name: "Home" } },
    ctx({ state: FlowState.AWAITING_LOCATION }),
  );
  assert.equal(r.state, FlowState.AWAITING_LANDMARK);
  const saved = r.effects.find((e) => e.type === ACTIONS.SAVE_LOCATION);
  assert.ok(saved && "latitude" in saved && saved.latitude === 12.97);
});

test("refusing to share a location offers a typed-address fallback", () => {
  const r = step({ text: "I can't share location" }, ctx({ state: FlowState.AWAITING_LOCATION }));
  assert.equal(r.state, FlowState.AWAITING_LOCATION, "must not dead-end");
  assert.match((r.replies[0] as { text: string }).text, /type your full address/i);
});

// --- resilience -----------------------------------------------------------

test("three invalid inputs escalate to a human", () => {
  const r = step(
    { text: "???" },
    ctx({ state: FlowState.BROWSING_CATEGORIES, failureCount: 2 }),
  );
  assert.equal(r.state, FlowState.HANDOVER);
  assert.ok(effects(r).includes(ACTIONS.ESCALATE));
});

test("asking for an agent escalates immediately", () => {
  const r = step({ text: "agent" }, ctx({ state: FlowState.BROWSING_PRODUCTS }));
  assert.equal(r.state, FlowState.HANDOVER);
});

test("the bot stays silent once a human has taken over", () => {
  const r = step({ text: "still there?" }, ctx({ state: FlowState.HANDOVER }));
  assert.deepEqual(r.replies, []);
});

test("'menu' rescues a customer stranded in any state", () => {
  for (const state of Object.values(FlowState)) {
    const r = step({ text: "menu" }, ctx({ state }));
    assert.ok(
      [FlowState.BROWSING_CATEGORIES, FlowState.AWAITING_OPTIN, FlowState.IDLE].includes(r.state),
      `state ${state} should recover, got ${r.state}`,
    );
  }
});

test("a returning customer after session expiry is not re-asked for consent", () => {
  const r = step({ text: "hi" }, ctx({ state: FlowState.IDLE, hasOptedIn: true }));
  assert.equal(r.state, FlowState.BROWSING_CATEGORIES);
});

const CART = [{ title: "Atta", unitPriceMinor: 27500, quantity: 2, gstRatePercent: 5 }];

test("a landmark note is captured, not silently dropped", () => {
  const r = step(
    { text: "2nd floor, blue gate" },
    ctx({ state: FlowState.AWAITING_LANDMARK, cartLines: CART }),
  );
  const saved = r.effects.find((e) => e.type === ACTIONS.SAVE_LANDMARK);
  assert.ok(saved && "note" in saved && saved.note === "2nd floor, blue gate");
  assert.match((r.replies[0] as { text: string }).text, /2nd floor, blue gate/);
  assert.equal(r.state, FlowState.AWAITING_PAYMENT_MODE);
});

test("the landmark step can be skipped", () => {
  const r = step({ text: "skip" }, ctx({ state: FlowState.AWAITING_LANDMARK, cartLines: CART }));
  const saved = r.effects.find((e) => e.type === ACTIONS.SAVE_LANDMARK);
  assert.ok(saved && "note" in saved && saved.note === null);
});

// --- payment --------------------------------------------------------------

test("an eligible order is offered both COD and online", () => {
  const r = step({ text: "skip" }, ctx({ state: FlowState.AWAITING_LANDMARK, cartLines: CART }));
  const btn = r.replies.find((x) => x.kind === "buttons");
  assert.ok(btn && btn.kind === "buttons");
  assert.deepEqual(btn.buttons.map((b) => b.id), ["pay:cod", "pay:online"]);
});

test("an unserviceable pin blocks the order and escalates", () => {
  const r = step(
    { text: "skip" },
    ctx({
      state: FlowState.AWAITING_LANDMARK, cartLines: CART,
      delivery: { ...ZONE, serviceable: false },
    }),
  );
  assert.equal(r.state, FlowState.HANDOVER);
  assert.ok(r.effects.some((e) => e.type === ACTIONS.ESCALATE));
  assert.ok(!r.effects.some((e) => e.type === ACTIONS.CREATE_ORDER));
});

test("above the COD ceiling only online payment is offered", () => {
  const r = step(
    { text: "skip" },
    ctx({
      state: FlowState.AWAITING_LANDMARK,
      cartLines: [{ title: "Bulk", unitPriceMinor: 600000, quantity: 1, gstRatePercent: 5 }],
    }),
  );
  const btn = r.replies.find((x) => x.kind === "buttons");
  assert.ok(btn && btn.kind === "buttons");
  assert.deepEqual(btn.buttons.map((b) => b.id), ["pay:online"]);
});

test("choosing COD creates the order and sends no reply of its own", () => {
  const r = step(
    { replyId: "pay:cod" },
    ctx({ state: FlowState.AWAITING_PAYMENT_MODE, cartLines: CART }),
  );
  const created = r.effects.find((e) => e.type === ACTIONS.CREATE_ORDER);
  assert.ok(created && "paymentMode" in created && created.paymentMode === "COD");
  // The confirmation is sent by the handler once the order has a number.
  assert.deepEqual(r.replies, []);
});

test("COD is re-checked at the moment of choosing, not just when rendered", () => {
  // Cart grew past the ceiling after the buttons were drawn.
  const r = step(
    { replyId: "pay:cod" },
    ctx({
      state: FlowState.AWAITING_PAYMENT_MODE,
      cartLines: [{ title: "Bulk", unitPriceMinor: 600000, quantity: 1, gstRatePercent: 5 }],
    }),
  );
  assert.ok(!r.effects.some((e) => e.type === ACTIONS.CREATE_ORDER));
  assert.equal(r.state, FlowState.AWAITING_PAYMENT_MODE);
});

test("choosing online payment moves to awaiting payment", () => {
  const r = step(
    { replyId: "pay:online" },
    ctx({ state: FlowState.AWAITING_PAYMENT_MODE, cartLines: CART }),
  );
  assert.equal(r.state, FlowState.AWAITING_PAYMENT);
  const created = r.effects.find((e) => e.type === ACTIONS.CREATE_ORDER);
  assert.ok(created && "paymentMode" in created && created.paymentMode === "ONLINE");
});

test("an order below the minimum value cannot be placed at all", () => {
  const r = step(
    { text: "skip" },
    ctx({
      state: FlowState.AWAITING_LANDMARK,
      cartLines: [{ title: "Sweets", unitPriceMinor: 3000, quantity: 1, gstRatePercent: 5 }],
    }),
  );
  assert.equal(r.state, FlowState.HANDOVER);
  assert.match((r.replies[0] as { text: string }).text, /Minimum order/i);
});
