/**
 * All money is an integer count of paise. Never a float, never a Decimal at
 * the boundary - rounding happens once, here, and the parts always sum back
 * to the whole.
 *
 * Shop prices are treated as GST-INCLUSIVE, which is how Indian retail MRP
 * works. The tax component is extracted backwards for the invoice.
 */

export const RUPEE = 100;

export interface GstSplit {
  /** Taxable value, i.e. price before tax. */
  taxableMinor: number;
  /** The GST component contained in the inclusive price. */
  taxMinor: number;
  /** What the customer actually pays. Equals taxable + tax, exactly. */
  totalMinor: number;
}

/**
 * Split a GST-inclusive amount into taxable value and tax.
 *
 * Tax is rounded to the nearest paisa and the taxable value is derived by
 * subtraction, so the two always add back to the original amount - no
 * off-by-one paisa on the invoice.
 */
export function splitInclusiveGst(
  inclusiveMinor: number,
  ratePercent: number,
): GstSplit {
  if (!Number.isInteger(inclusiveMinor)) {
    throw new TypeError(`amount must be integer paise, got ${inclusiveMinor}`);
  }
  if (ratePercent < 0) throw new RangeError("GST rate cannot be negative");
  if (ratePercent === 0) {
    return { taxableMinor: inclusiveMinor, taxMinor: 0, totalMinor: inclusiveMinor };
  }

  const rate = ratePercent / 100;
  const taxMinor = Math.round(inclusiveMinor - inclusiveMinor / (1 + rate));
  return {
    taxableMinor: inclusiveMinor - taxMinor,
    taxMinor,
    totalMinor: inclusiveMinor,
  };
}

/**
 * Intra-state supply splits GST evenly into CGST and SGST. The halves are
 * derived by subtraction so an odd paisa cannot go missing.
 */
export function splitCgstSgst(taxMinor: number): { cgstMinor: number; sgstMinor: number } {
  const cgstMinor = Math.floor(taxMinor / 2);
  return { cgstMinor, sgstMinor: taxMinor - cgstMinor };
}

/** "27500" -> "₹275.00" */
export function formatMinor(minor: number, currency = "INR"): string {
  const symbol = currency === "INR" ? "\u20B9" : "";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${symbol}${Math.floor(abs / RUPEE)}.${String(abs % RUPEE).padStart(2, "0")}`;
}

/** Parse "2", "2.5", "₹2.50" into paise. Returns null when not a number. */
export function parseToMinor(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "");
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * RUPEE);
}
