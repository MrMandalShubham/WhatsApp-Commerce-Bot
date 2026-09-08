import type { CartLineInput } from "../cart";
import type { DeliveryZone } from "../order";

export enum FlowState {
  GREETING = "greeting",
  AWAITING_OPTIN = "awaiting_optin",
  BROWSING_CATEGORIES = "browsing_categories",
  BROWSING_PRODUCTS = "browsing_products",
  AWAITING_QUANTITY = "awaiting_quantity",
  CART_REVIEW = "cart_review",
  AWAITING_LOCATION = "awaiting_location",
  AWAITING_LANDMARK = "awaiting_landmark",
  AWAITING_PAYMENT_MODE = "awaiting_payment_mode",
  AWAITING_PAYMENT = "awaiting_payment",
  HANDOVER = "handover",
  IDLE = "idle",
}

export const ACTIONS = {
  RECORD_CONSENT: "record_consent",
  SET_CATEGORY: "set_category",
  SET_PENDING_PRODUCT: "set_pending_product",
  ADD_TO_CART: "add_to_cart",
  CLEAR_CART: "clear_cart",
  SAVE_LOCATION: "save_location",
  SAVE_LANDMARK: "save_landmark",
  CREATE_ORDER: "create_order",
  ESCALATE: "escalate",
  INCREMENT_FAILURE: "increment_failure",
} as const;

export interface FlowInput {
  text?: string;
  replyId?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}

export interface CategoryView {
  id: string;
  name: string;
}

export interface ProductView {
  id: string;
  title: string;
  priceMinor: number;
  gstRatePercent: number;
  available: number;
}

export interface FlowContext {
  state: FlowState;
  shopName: string;
  currency: string;
  hasOptedIn: boolean;
  failureCount: number;
  pendingProductId?: string | null;
  selectedCategoryId?: string | null;
  cartLines: CartLineInput[];
  cartItemCount: number;
  /** Serviceability for the pin the customer shared, resolved by PostGIS. */
  delivery?: DeliveryZone;
  /** False while the shop has no payment gateway configured (COD only). */
  onlinePaymentsEnabled?: boolean;
  categories: CategoryView[];
  productsInCategory(categoryId: string): ProductView[];
  findProduct(productId: string): ProductView | undefined;
}

export type Reply =
  | { kind: "text"; text: string }
  | {
      kind: "buttons";
      text: string;
      buttons: Array<{ id: string; title: string }>;
      header?: string;
      footer?: string;
    }
  | {
      kind: "list";
      text: string;
      buttonLabel: string;
      sections: Array<{
        title: string;
        rows: Array<{ id: string; title: string; description?: string }>;
      }>;
      header?: string;
      footer?: string;
    }
  | { kind: "location_request"; text: string };

export type Effect =
  | { type: typeof ACTIONS.RECORD_CONSENT; action: "OPT_IN" | "OPT_OUT"; wordingShown: string }
  | { type: typeof ACTIONS.SET_CATEGORY; categoryId: string }
  | { type: typeof ACTIONS.SET_PENDING_PRODUCT; productId: string | null }
  | { type: typeof ACTIONS.ADD_TO_CART; productId: string; quantity: number }
  | { type: typeof ACTIONS.CLEAR_CART }
  | {
      type: typeof ACTIONS.SAVE_LOCATION;
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | { type: typeof ACTIONS.SAVE_LANDMARK; note: string | null }
  | { type: typeof ACTIONS.CREATE_ORDER; paymentMode: "COD" | "ONLINE" }
  | { type: typeof ACTIONS.ESCALATE; reason: string }
  | { type: typeof ACTIONS.INCREMENT_FAILURE };

export interface FlowResult {
  state: FlowState;
  replies: Reply[];
  effects: Effect[];
}
