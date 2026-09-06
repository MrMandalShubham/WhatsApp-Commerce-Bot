"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ApiError, call, del, patch, post, rupees, type ProductRow } from "@/lib/api";

interface Category {
  id: string;
  name: string;
  slug: string;
}

/** Common Indian GST slabs, so nobody has to remember them. */
const GST_SLABS = [0, 5, 12, 18, 28];

interface Props {
  /** Absent = creating a new product. */
  product?: ProductRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

/** Delete is refused once a product has been sold; offer the safe path instead. */
function isHistoryBlock(message: string): boolean {
  return /order line|open cart/i.test(message);
}

export function ProductForm({ product, onClose, onSaved }: Props) {
  const editing = Boolean(product);

  const [categories, setCategories] = useState<Category[]>([]);
  const [sku, setSku] = useState(product?.sku ?? "");
  const [title, setTitle] = useState(product?.title ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [hsnCode, setHsnCode] = useState("");
  const [gstRate, setGstRate] = useState(product ? String(product.gstRate) : "5");
  // Priced in rupees in the UI, converted to paise on the way out - staff
  // should never have to think in paise.
  const [price, setPrice] = useState(
    product ? (product.priceMinor / 100).toFixed(2) : "",
  );
  const [onHand, setOnHand] = useState("0");
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [reason, setReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await call<Category[]>("/categories");
        setCategories(rows);
        if (!editing && rows.length && !categoryId) setCategoryId(rows[0].id);
      } catch {
        /* the form still works without categories */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const priceMinor = Math.round(Number(price.replace(/[^0-9.]/g, "")) * 100);
  const priceValid = Number.isFinite(priceMinor) && priceMinor > 0;
  const skuValid = /^[A-Za-z0-9-]{2,64}$/.test(sku.trim());

  async function addCategory() {
    const name = newCategory.trim();
    if (name.length < 2) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setBusy(true);
    setError(null);
    try {
      const c = await post<Category>("/categories", { name, slug });
      setCategories((cs) => [...cs, c]);
      setCategoryId(c.id);
      setNewCategory("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add the category");
    } finally {
      setBusy(false);
    }
  }

  const onHandNow = product?.stock?.onHand ?? 0;
  const heldNow = product?.stock?.reserved ?? 0;
  const stockValue = onHandNow * (product?.priceMinor ?? 0);

  async function doDelete() {
    if (!product) return;
    setBusy(true);
    setError(null);
    setBlocked(false);
    try {
      await del(`/products/${product.id}`);
      onSaved(`${product.title} deleted`);
      onClose();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not delete";
      setError(msg);
      setBlocked(isHistoryBlock(msg));
      setConfirming(false); // fall back to the drawer so the reason is readable
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing && product) {
        await patch(`/products/${product.id}`, {
          title: title.trim(),
          priceMinor,
          gstRate: Number(gstRate),
          isActive,
          ...(hsnCode.trim() ? { hsnCode: hsnCode.trim() } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}),
        });
        onSaved(`${title.trim()} updated`);
      } else {
        await post("/products", {
          sku: sku.trim().toUpperCase(),
          title: title.trim(),
          gstRate: Number(gstRate),
          priceMinor,
          isActive,
          ...(categoryId ? { categoryId } : {}),
          ...(hsnCode.trim() ? { hsnCode: hsnCode.trim() } : {}),
          onHand: Math.max(0, Number(onHand) || 0),
        });
        onSaved(`${title.trim()} added`);
      }
      onClose();
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-bg" onClick={onClose} role="dialog" aria-modal="true">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h1>{editing ? "Edit product" : "New product"}</h1>
            <p className="sub" style={{ margin: 0 }}>
              {editing
                ? "Price changes do not affect orders already placed."
                : "Creates the product and its stock row."}
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="alert err">{error}</div>}

        <form className="card pad" onSubmit={save}>
          <label htmlFor="title">Product name</label>
          <input
            id="title" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Toor Dal 1 kg" required autoFocus
          />

          <label htmlFor="sku">SKU {editing && <span className="muted">(cannot be changed)</span>}</label>
          <input
            id="sku" value={sku} onChange={(e) => setSku(e.target.value)}
            placeholder="GRC-DAL-1KG" disabled={editing} required
            aria-describedby="sku-help"
          />
          {!editing && !skuValid && sku.length > 0 && (
            <p id="sku-help" className="small warn" style={{ marginTop: 6 }}>
              Letters, digits and hyphens only.
            </p>
          )}

          <label htmlFor="cat">Category</label>
          <select id="cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {!editing && (
            <div className="btns" style={{ marginTop: 8 }}>
              <input
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="…or add a new category"
                style={{ maxWidth: 240 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void addCategory(); }
                }}
              />
              <button type="button" className="btn ghost sm" disabled={busy || newCategory.trim().length < 2}
                      onClick={() => void addCategory()}>
                Add
              </button>
            </div>
          )}

          <label htmlFor="price">Price (₹, including GST)</label>
          <input
            id="price" inputMode="decimal" value={price}
            onChange={(e) => setPrice(e.target.value)} placeholder="185.00" required
          />
          {price !== "" && !priceValid && (
            <p className="small warn" style={{ marginTop: 6 }}>Enter an amount greater than zero.</p>
          )}
          {priceValid && (
            <p className="small muted" style={{ marginTop: 6 }}>
              Stored as {priceMinor} paise. Shop prices are GST-inclusive; the tax
              component is worked out on the invoice.
            </p>
          )}

          <label htmlFor="gst">GST rate</label>
          <select id="gst" value={gstRate} onChange={(e) => setGstRate(e.target.value)}>
            {GST_SLABS.map((g) => <option key={g} value={g}>{g}%</option>)}
          </select>

          <label htmlFor="hsn">HSN code <span className="muted">(needed on GST invoices)</span></label>
          <input id="hsn" value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} placeholder="0713" />

          {!editing && (
            <>
              <label htmlFor="stock">Opening stock</label>
              <input
                id="stock" inputMode="numeric" value={onHand}
                onChange={(e) => setOnHand(e.target.value)}
              />
              <p className="small muted" style={{ marginTop: 6 }}>
                Leave at 0 and the product stays hidden from customers until you add stock.
              </p>
            </>
          )}

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
            <input
              type="checkbox" checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              style={{ width: 18, minHeight: 18 }}
            />
            <span>Available to order</span>
          </label>

          {editing && (
            <>
              <label htmlFor="why">Reason <span className="muted">(optional, for the audit log)</span></label>
              <input
                id="why" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="supplier price increase"
              />
            </>
          )}

          <div className="btns" style={{ marginTop: 18 }}>
            <button className="btn" disabled={busy || !priceValid || (!editing && !skuValid) || !title.trim()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Add product"}
            </button>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>

        {editing && product && (
          <div className="card pad" style={{ marginTop: 18, borderColor: "#f0c6c3" }}>
            <h2 style={{ marginTop: 0 }}>Delete product</h2>
            <p className="small muted">
              Removes {product.title} and its stock entirely. Only possible while the
              product has never been ordered — once it has been sold, switch it off
              above instead so the order history stays intact.
            </p>

            {blocked && (
              <div className="btns" style={{ marginBottom: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await patch(`/products/${product.id}`, {
                        isActive: false,
                        reason: "withdrawn from the catalogue",
                      });
                      onSaved(`${product.title} switched off — it is hidden from customers`);
                      onClose();
                    } catch (e) {
                      setError(e instanceof ApiError ? e.message : "Could not switch it off");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Switch it off instead
                </button>
              </div>
            )}

            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Delete permanently
            </button>
          </div>
        )}

        {confirming && product && (
          <ConfirmDialog
            title={`Delete ${product.title}?`}
            body={
              <>
                This removes the product and its stock record permanently.{" "}
                <strong>It cannot be undone.</strong>
              </>
            }
            warning={
              onHandNow > 0 ? (
                <>
                  <span className="big">
                    {onHandNow} unit{onHandNow === 1 ? "" : "s"} still in stock
                    {stockValue > 0 ? ` · about ${rupees(stockValue)}` : ""}
                  </span>
                  That stock disappears with the product. If you are only taking it off
                  the menu, switch off &ldquo;Available to order&rdquo; instead.
                  {heldNow > 0 && (
                    <>
                      {" "}
                      <strong>{heldNow}</strong> of these are held by an open cart.
                    </>
                  )}
                </>
              ) : undefined
            }
            confirmLabel={onHandNow > 0 ? `Delete anyway (${onHandNow} in stock)` : "Delete permanently"}
            busy={busy}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void doDelete()}
          />
        )}
      </aside>
    </div>
  );
}
