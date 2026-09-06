import { formatMinor, splitInclusiveGst } from "./money";

export interface CartLineInput {
  title: string;
  unitPriceMinor: number; // GST-inclusive
  quantity: number;
  gstRatePercent: number;
}

export interface CartLine extends CartLineInput {
  lineTotalMinor: number;
  taxableMinor: number;
  taxMinor: number;
}

export interface CartTotals {
  lines: CartLine[];
  subtotalMinor: number; // sum of taxable values
  taxMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  itemCount: number;
}

/**
 * Tax is computed per line and summed, not computed on the summed total -
 * lines can carry different GST rates (5% on staples, 18% on biscuits), so a
 * single blended rate would be wrong on the invoice.
 */
export function computeTotals(
  input: CartLineInput[],
  deliveryFeeMinor = 0,
): CartTotals {
  const lines: CartLine[] = input.map((l) => {
    if (l.quantity <= 0 || !Number.isInteger(l.quantity)) {
      throw new RangeError(`quantity must be a positive integer, got ${l.quantity}`);
    }
    const lineTotalMinor = l.unitPriceMinor * l.quantity;
    const { taxableMinor, taxMinor } = splitInclusiveGst(
      lineTotalMinor,
      l.gstRatePercent,
    );
    return { ...l, lineTotalMinor, taxableMinor, taxMinor };
  });

  const subtotalMinor = lines.reduce((s, l) => s + l.taxableMinor, 0);
  const taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0);

  return {
    lines,
    subtotalMinor,
    taxMinor,
    deliveryFeeMinor,
    totalMinor: subtotalMinor + taxMinor + deliveryFeeMinor,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
  };
}

/** Plain-text cart summary for a WhatsApp message body. */
export function renderCart(totals: CartTotals, currency = "INR"): string {
  if (!totals.lines.length) return "Your cart is empty.";

  const rows = totals.lines
    .map(
      (l) =>
        `• ${l.title}\n   ${l.quantity} × ${formatMinor(l.unitPriceMinor, currency)} = ${formatMinor(l.lineTotalMinor, currency)}`,
    )
    .join("\n");

  const parts = [
    rows,
    "",
    `Subtotal: ${formatMinor(totals.subtotalMinor, currency)}`,
    `GST: ${formatMinor(totals.taxMinor, currency)}`,
  ];
  if (totals.deliveryFeeMinor > 0) {
    parts.push(`Delivery: ${formatMinor(totals.deliveryFeeMinor, currency)}`);
  }
  parts.push(`*Total: ${formatMinor(totals.totalMinor, currency)}*`);
  return parts.join("\n");
}
