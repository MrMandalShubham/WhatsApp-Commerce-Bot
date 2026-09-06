import { formatMinor } from "../money";
import { computeTotals, renderCart } from "../cart";
import { checkCodEligibility, checkOrderable } from "../order";
import {
  ACTIONS,
  FlowState,
  type FlowContext,
  type FlowInput,
  type FlowResult,
  type Reply,
} from "./types";

const MAX_LIST_ROWS = 10;
const MAX_FAILURES = 3;

/**
 * The conversation as a pure function: (state, input, context) -> replies +
 * effects. It touches no database and sends nothing, which is what makes the
 * whole flow testable without Docker running.
 *
 * The caller performs the effects and persists the returned state.
 */
export function step(input: FlowInput, ctx: FlowContext): FlowResult {
  const say = (text: string): Reply => ({ kind: "text", text });

  // A customer who types "hi", "menu" or "start" always gets a clean entry
  // point, whatever state they were stranded in.
  if (isRestart(input)) {
    return ctx.hasOptedIn ? showCategories(ctx) : askOptIn(ctx);
  }

  if (matches(input, "cart")) return showCart(ctx);
  if (matches(input, "help")) {
    return {
      state: ctx.state,
      replies: [
        say(
          "You can send:\n• *menu* — browse products\n• *cart* — see your cart\n• *track* — check an order\n\nOr type *agent* to reach a person.",
        ),
      ],
      effects: [],
    };
  }
  if (matches(input, "agent", "human", "support")) {
    return {
      state: FlowState.HANDOVER,
      replies: [say("Connecting you to our team — someone will reply here shortly.")],
      effects: [{ type: ACTIONS.ESCALATE, reason: "customer_requested" }],
    };
  }

  switch (ctx.state) {
    case FlowState.GREETING:
    case FlowState.IDLE:
      return ctx.hasOptedIn ? showCategories(ctx) : askOptIn(ctx);

    case FlowState.AWAITING_OPTIN:
      return handleOptIn(input, ctx);

    case FlowState.BROWSING_CATEGORIES:
      return handleCategoryChoice(input, ctx);

    case FlowState.BROWSING_PRODUCTS:
      return handleProductChoice(input, ctx);

    case FlowState.AWAITING_QUANTITY:
      return handleQuantity(input, ctx);

    case FlowState.CART_REVIEW:
      return handleCartAction(input, ctx);

    case FlowState.AWAITING_LOCATION:
      return handleLocation(input, ctx);

    case FlowState.AWAITING_LANDMARK:
      return handleLandmark(input, ctx);

    case FlowState.AWAITING_PAYMENT_MODE:
      return handlePaymentMode(input, ctx);

    case FlowState.AWAITING_PAYMENT:
      return handleAwaitingPayment(input, ctx);

    case FlowState.HANDOVER:
      // Stay quiet - a human owns this conversation now.
      return { state: FlowState.HANDOVER, replies: [], effects: [] };

    default:
      return fallback(ctx);
  }
}

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

const OPT_IN_WORDING =
  "May we send you order updates on WhatsApp? You can stop them any time by replying STOP.";

function askOptIn(ctx: FlowContext): FlowResult {
  return {
    state: FlowState.AWAITING_OPTIN,
    replies: [
      {
        kind: "buttons",
        header: `Welcome to ${ctx.shopName}`,
        text: OPT_IN_WORDING,
        buttons: [
          { id: "optin:yes", title: "Yes, please" },
          { id: "optin:no", title: "Not now" },
        ],
      },
    ],
    effects: [],
  };
}

function handleOptIn(input: FlowInput, ctx: FlowContext): FlowResult {
  const yes =
    input.replyId === "optin:yes" || matches(input, "yes", "y", "ok", "sure");
  const no = input.replyId === "optin:no" || matches(input, "no", "n", "stop");

  if (yes) {
    const next = showCategories(ctx);
    return {
      ...next,
      effects: [
        {
          type: ACTIONS.RECORD_CONSENT,
          action: "OPT_IN",
          wordingShown: OPT_IN_WORDING,
        },
        ...next.effects,
      ],
    };
  }

  if (no) {
    // Browsing is still allowed - consent only gates template notifications.
    const next = showCategories(ctx);
    return {
      ...next,
      replies: [
        { kind: "text", text: "No problem — we won't send you updates." },
        ...next.replies,
      ],
      effects: [
        {
          type: ACTIONS.RECORD_CONSENT,
          action: "OPT_OUT",
          wordingShown: OPT_IN_WORDING,
        },
        ...next.effects,
      ],
    };
  }

  return retry(ctx, "Please tap *Yes, please* or *Not now* to continue.");
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

function showCategories(ctx: FlowContext): FlowResult {
  if (!ctx.categories.length) {
    return {
      state: FlowState.IDLE,
      replies: [{ kind: "text", text: "Our catalogue is being updated — please check back shortly." }],
      effects: [],
    };
  }

  return {
    state: FlowState.BROWSING_CATEGORIES,
    replies: [
      {
        kind: "list",
        header: `Welcome to ${ctx.shopName}`,
        text: "What would you like to order today?",
        buttonLabel: "Browse",
        sections: [
          {
            title: "Categories",
            rows: ctx.categories.slice(0, MAX_LIST_ROWS).map((c) => ({
              id: `cat:${c.id}`,
              title: c.name,
            })),
          },
        ],
        footer: ctx.cartItemCount > 0 ? `Cart: ${ctx.cartItemCount} item(s)` : undefined,
      },
    ],
    effects: [],
  };
}

function handleCategoryChoice(input: FlowInput, ctx: FlowContext): FlowResult {
  const id = idFrom(input, "cat");
  const category = ctx.categories.find((c) => c.id === id);
  if (!category) {
    return retry(ctx, "Please pick a category from the list.");
  }

  const products = ctx.productsInCategory(category.id);
  if (!products.length) {
    return {
      state: FlowState.BROWSING_CATEGORIES,
      replies: [
        { kind: "text", text: `Nothing in ${category.name} right now. Pick another category.` },
        ...showCategories(ctx).replies,
      ],
      effects: [],
    };
  }

  const inStock = products.filter((p) => p.available > 0);
  const outOfStock = products.length - inStock.length;

  if (!inStock.length) {
    return {
      state: FlowState.BROWSING_CATEGORIES,
      replies: [
        { kind: "text", text: `Everything in ${category.name} is out of stock at the moment.` },
      ],
      effects: [],
    };
  }

  return {
    state: FlowState.BROWSING_PRODUCTS,
    replies: [
      {
        kind: "list",
        header: category.name,
        text: "Tap an item to add it to your cart.",
        buttonLabel: "See items",
        sections: [
          {
            title: category.name,
            rows: inStock.slice(0, MAX_LIST_ROWS).map((p) => ({
              id: `prod:${p.id}`,
              title: p.title,
              description: `${formatMinor(p.priceMinor, ctx.currency)}${p.available < 5 ? ` · only ${p.available} left` : ""}`,
            })),
          },
        ],
        footer: outOfStock > 0 ? `${outOfStock} item(s) out of stock` : undefined,
      },
    ],
    effects: [{ type: ACTIONS.SET_CATEGORY, categoryId: category.id }],
  };
}

function handleProductChoice(input: FlowInput, ctx: FlowContext): FlowResult {
  const id = idFrom(input, "prod");
  const product = ctx.findProduct(id ?? "");
  if (!product) return retry(ctx, "Please choose an item from the list.");

  if (product.available <= 0) {
    return {
      state: FlowState.BROWSING_PRODUCTS,
      replies: [{ kind: "text", text: `Sorry, ${product.title} just went out of stock.` }],
      effects: [],
    };
  }

  const max = Math.min(3, product.available);
  return {
    state: FlowState.AWAITING_QUANTITY,
    replies: [
      {
        kind: "buttons",
        header: product.title,
        text: `${formatMinor(product.priceMinor, ctx.currency)} each.\nHow many would you like?`,
        buttons: Array.from({ length: max }, (_, i) => ({
          id: `qty:${i + 1}`,
          title: String(i + 1),
        })),
        footer: product.available > 3 ? "Or reply with a number" : undefined,
      },
    ],
    effects: [{ type: ACTIONS.SET_PENDING_PRODUCT, productId: product.id }],
  };
}

function handleQuantity(input: FlowInput, ctx: FlowContext): FlowResult {
  const product = ctx.findProduct(ctx.pendingProductId ?? "");
  if (!product) return showCategories(ctx);

  const raw = idFrom(input, "qty") ?? input.text?.trim() ?? "";
  const qty = Number.parseInt(raw, 10);

  if (!Number.isInteger(qty) || qty <= 0) {
    return retry(ctx, "Please tap a number, or reply with a quantity like *2*.");
  }
  if (qty > product.available) {
    return {
      state: FlowState.AWAITING_QUANTITY,
      replies: [
        {
          kind: "text",
          text: `We only have ${product.available} of ${product.title} left. Please choose ${product.available} or fewer.`,
        },
      ],
      effects: [],
    };
  }

  const totals = computeTotals([
    ...ctx.cartLines,
    {
      title: product.title,
      unitPriceMinor: product.priceMinor,
      quantity: qty,
      gstRatePercent: product.gstRatePercent,
    },
  ]);

  return {
    state: FlowState.CART_REVIEW,
    replies: [
      {
        kind: "buttons",
        header: "Cart updated",
        text: `${renderCart(totals, ctx.currency)}`,
        buttons: [
          { id: "cart:more", title: "Add more" },
          { id: "cart:checkout", title: "Checkout" },
          { id: "cart:clear", title: "Clear cart" },
        ],
      },
    ],
    effects: [
      { type: ACTIONS.ADD_TO_CART, productId: product.id, quantity: qty },
      { type: ACTIONS.SET_PENDING_PRODUCT, productId: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function showCart(ctx: FlowContext): FlowResult {
  if (!ctx.cartLines.length) {
    return {
      state: FlowState.BROWSING_CATEGORIES,
      replies: [
        { kind: "text", text: "Your cart is empty." },
        ...showCategories(ctx).replies,
      ],
      effects: [],
    };
  }
  const totals = computeTotals(ctx.cartLines);
  return {
    state: FlowState.CART_REVIEW,
    replies: [
      {
        kind: "buttons",
        header: "Your cart",
        text: renderCart(totals, ctx.currency),
        buttons: [
          { id: "cart:more", title: "Add more" },
          { id: "cart:checkout", title: "Checkout" },
          { id: "cart:clear", title: "Clear cart" },
        ],
      },
    ],
    effects: [],
  };
}

function handleCartAction(input: FlowInput, ctx: FlowContext): FlowResult {
  const action = idFrom(input, "cart");

  if (action === "more" || matches(input, "add", "more")) return showCategories(ctx);

  if (action === "clear" || matches(input, "clear")) {
    return {
      state: FlowState.BROWSING_CATEGORIES,
      replies: [
        { kind: "text", text: "Cart cleared." },
        ...showCategories(ctx).replies,
      ],
      effects: [{ type: ACTIONS.CLEAR_CART }],
    };
  }

  if (action === "checkout" || matches(input, "checkout", "buy", "order")) {
    if (!ctx.cartLines.length) return showCart(ctx);
    return {
      state: FlowState.AWAITING_LOCATION,
      replies: [
        {
          kind: "location_request",
          text: "Please share your delivery location so our rider can find you quickly.",
        },
      ],
      effects: [],
    };
  }

  return retry(ctx, "Please tap one of the buttons to continue.");
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

function handleLocation(input: FlowInput, ctx: FlowContext): FlowResult {
  if (!input.location) {
    // Refusing the permission must never dead-end the order.
    return {
      state: FlowState.AWAITING_LOCATION,
      replies: [
        {
          kind: "text",
          text: "No problem — you can also type your full address with a nearby landmark, and we'll locate it.",
        },
      ],
      effects: [],
    };
  }

  return {
    state: FlowState.AWAITING_LANDMARK,
    replies: [
      {
        kind: "text",
        text: "Got it, thank you. Any landmark or delivery note for the rider? (floor, gate, shop name)",
      },
    ],
    effects: [
      {
        type: ACTIONS.SAVE_LOCATION,
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        name: input.location.name,
        address: input.location.address,
      },
    ],
  };
}

function handleLandmark(input: FlowInput, ctx: FlowContext): FlowResult {
  const raw = input.text?.trim() ?? "";
  const skipped = /^(skip|no|none|-)$/i.test(raw);
  const note = skipped || !raw ? null : raw;

  const zone = ctx.delivery;
  const totals = computeTotals(ctx.cartLines, zone?.deliveryFeeMinor ?? 0);

  // Serviceability is decided by a polygon test against the shared pin, not
  // by the typed PIN code.
  const orderable = zone
    ? checkOrderable(totals.totalMinor, zone, ctx.currency)
    : { allowed: false, message: "We could not confirm your delivery area." };

  if (!orderable.allowed) {
    return {
      state: FlowState.HANDOVER,
      replies: [
        {
          kind: "text",
          text: `${orderable.message} Our team will contact you here shortly to sort this out.`,
        },
      ],
      effects: [
        { type: ACTIONS.SAVE_LANDMARK, note },
        { type: ACTIONS.ESCALATE, reason: orderable.reason ?? "not_serviceable" },
      ],
    };
  }

  const cod = checkCodEligibility(totals.totalMinor, zone!, ctx.currency);
  const buttons = cod.allowed
    ? [
        { id: "pay:cod", title: "Cash on delivery" },
        { id: "pay:online", title: "Pay online" },
      ]
    : [{ id: "pay:online", title: "Pay online" }];

  const body = [
    renderCart(totals, ctx.currency),
    "",
    note ? `Delivery note: ${note}` : "No delivery note added.",
    ...(cod.allowed ? [] : ["", cod.message ?? ""]),
    "",
    "How would you like to pay?",
  ].join("\n");

  return {
    state: FlowState.AWAITING_PAYMENT_MODE,
    replies: [{ kind: "buttons", header: "Confirm your order", text: body, buttons }],
    effects: [{ type: ACTIONS.SAVE_LANDMARK, note }],
  };
}

function handlePaymentMode(input: FlowInput, ctx: FlowContext): FlowResult {
  const choice = idFrom(input, "pay");
  const zone = ctx.delivery;
  const totals = computeTotals(ctx.cartLines, zone?.deliveryFeeMinor ?? 0);

  if (choice === "cod" || matches(input, "cod", "cash")) {
    // Re-check at the moment of choosing: the cart may have grown past the
    // COD ceiling since the buttons were rendered.
    const cod = zone
      ? checkCodEligibility(totals.totalMinor, zone, ctx.currency)
      : { allowed: false, message: "We could not confirm your delivery area." };

    if (!cod.allowed) {
      return {
        state: FlowState.AWAITING_PAYMENT_MODE,
        replies: [
          {
            kind: "buttons",
            text: cod.message ?? "Cash on delivery is not available for this order.",
            buttons: [{ id: "pay:online", title: "Pay online" }],
          },
        ],
        effects: [],
      };
    }

    // The confirmation message is sent by the handler once the order exists
    // and has a number, so the machine emits no reply here.
    return {
      state: FlowState.IDLE,
      replies: [],
      effects: [{ type: ACTIONS.CREATE_ORDER, paymentMode: "COD" }],
    };
  }

  if (choice === "online" || matches(input, "online", "pay", "upi")) {
    return {
      state: FlowState.AWAITING_PAYMENT,
      replies: [],
      effects: [{ type: ACTIONS.CREATE_ORDER, paymentMode: "ONLINE" }],
    };
  }

  return retry(ctx, "Please choose a payment method using the buttons.");
}

function handleAwaitingPayment(input: FlowInput, ctx: FlowContext): FlowResult {
  if (matches(input, "paid", "done", "payment done")) {
    return {
      state: FlowState.AWAITING_PAYMENT,
      replies: [
        {
          kind: "text",
          text: "Thanks — we confirm payments automatically. You'll get a message here the moment it clears.",
        },
      ],
      effects: [],
    };
  }
  return {
    state: FlowState.AWAITING_PAYMENT,
    replies: [
      {
        kind: "text",
        text: "Your payment link is still open. Tap it to pay, or reply *agent* if you need help.",
      },
    ],
    effects: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function retry(ctx: FlowContext, message: string): FlowResult {
  const failures = ctx.failureCount + 1;
  if (failures >= MAX_FAILURES) {
    return {
      state: FlowState.HANDOVER,
      replies: [
        {
          kind: "text",
          text: "Let me get a person to help you — someone from our team will reply here shortly.",
        },
      ],
      effects: [{ type: ACTIONS.ESCALATE, reason: "repeated_invalid_input" }],
    };
  }
  return {
    state: ctx.state,
    replies: [{ kind: "text", text: message }],
    effects: [{ type: ACTIONS.INCREMENT_FAILURE }],
  };
}

function fallback(ctx: FlowContext): FlowResult {
  return ctx.hasOptedIn ? showCategories(ctx) : askOptIn(ctx);
}

function isRestart(input: FlowInput): boolean {
  return matches(input, "hi", "hello", "hey", "menu", "start", "namaste");
}

function matches(input: FlowInput, ...words: string[]): boolean {
  const t = input.text?.trim().toLowerCase();
  if (!t || input.replyId) return false;
  return words.includes(t);
}

/** "cat:abc" with prefix "cat" -> "abc" */
function idFrom(input: FlowInput, prefix: string): string | null {
  const id = input.replyId;
  if (!id?.startsWith(`${prefix}:`)) return null;
  return id.slice(prefix.length + 1);
}
