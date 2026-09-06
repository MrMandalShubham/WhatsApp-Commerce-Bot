"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, call, post, rupees, when } from "@/lib/api";

interface Detail {
  id: string;
  orderNumber: string;
  displayStatus: string;
  paymentMode: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  orderStatus: string;
  subtotalMinor: number;
  taxMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  placedAt: string | null;
  customer: { waPhone: string; name: string | null };
  address: { line1: string; landmark: string | null; latitude: string | null; longitude: string | null } | null;
  items: Array<{ titleSnapshot: string; skuSnapshot: string; quantity: number; lineTotalMinor: number; gstRate: string }>;
  payments: Array<{ attemptNo: number; status: string; amountMinor: number; linkUrl: string | null }>;
  delivery: { status: string; podType: string; recipientName: string | null; rider: { id: string; name: string } | null } | null;
  codCollection: { amountDueMinor: number; amountCollectedMinor: number } | null;
  statusHistory: Array<{ field: string; fromValue: string | null; toValue: string; actorType: string; reason: string | null; occurredAt: string }>;
}

/** Only transitions the machine actually allows, so staff aren't offered dead ends. */
const NEXT_FULFILLMENT: Record<string, string[]> = {
  UNFULFILLED: ["CONFIRMED"],
  CONFIRMED: ["PACKED"],
  PACKED: ["ASSIGNED"],
  ASSIGNED: ["OUT_FOR_DELIVERY", "PACKED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED_DELIVERY"],
  FAILED_DELIVERY: ["ASSIGNED", "RETURNED"],
  DELIVERED: ["RETURNED"],
  RETURNED: [],
};

export function OrderDrawer({
  orderId,
  riders,
  onClose,
  onChanged,
}: {
  orderId: string;
  riders: Array<{ id: string; name: string }>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [riderId, setRiderId] = useState("");

  const load = useCallback(async () => {
    try {
      setOrder(await call<Detail>(`/orders/${orderId}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the order");
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setFlash(label);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <div className="drawer-bg" onClick={onClose}>
        <aside className="drawer" onClick={(e) => e.stopPropagation()}>
          {error ? <div className="alert err">{error}</div> : <p className="muted">Loading…</p>}
        </aside>
      </div>
    );
  }

  const nexts = NEXT_FULFILLMENT[order.fulfillmentStatus] ?? [];
  const canCancel = !["CANCELLED", "COMPLETED"].includes(order.orderStatus);
  const needsReason = reason.trim().length < 3;

  return (
    <div className="drawer-bg" onClick={onClose} role="dialog" aria-modal="true">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h1>{order.orderNumber}</h1>
            <p className="sub" style={{ margin: 0 }}>
              {order.displayStatus} · {order.paymentMode} · {rupees(order.totalMinor)}
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>

        {flash && <div className="alert ok">{flash}</div>}
        {error && <div className="alert err">{error}</div>}

        <div className="card pad">
          <dl className="kv">
            <dt>Customer</dt>
            <dd>{order.customer.name ?? "—"} · <span className="mono">{order.customer.waPhone}</span></dd>
            <dt>Address</dt>
            <dd>
              {order.address?.line1 ?? "—"}
              {order.address?.landmark && <><br /><span className="muted">{order.address.landmark}</span></>}
            </dd>
            <dt>Placed</dt>
            <dd>{when(order.placedAt)}</dd>
            <dt>Rider</dt>
            <dd>{order.delivery?.rider?.name ?? "Not assigned"}</dd>
            {order.codCollection && (
              <>
                <dt>Cash</dt>
                <dd>
                  {rupees(order.codCollection.amountCollectedMinor)} collected of{" "}
                  {rupees(order.codCollection.amountDueMinor)}
                  {order.codCollection.amountCollectedMinor < order.codCollection.amountDueMinor && (
                    <span className="chip bad" style={{ marginLeft: 8 }}>
                      short {rupees(order.codCollection.amountDueMinor - order.codCollection.amountCollectedMinor)}
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
        </div>

        <h2>Items</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Item</th><th>SKU</th><th className="num">Qty</th><th className="num">GST</th><th className="num">Total</th></tr>
            </thead>
            <tbody>
              {order.items.map((i, n) => (
                <tr key={n}>
                  <td style={{ whiteSpace: "normal" }}>{i.titleSnapshot}</td>
                  <td className="mono small">{i.skuSnapshot}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num">{Number(i.gstRate)}%</td>
                  <td className="num">{rupees(i.lineTotalMinor)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4} className="num muted">Subtotal / GST / Delivery</td>
                <td className="num">
                  {rupees(order.subtotalMinor)} / {rupees(order.taxMinor)} / {rupees(order.deliveryFeeMinor)}
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="num"><strong>Total</strong></td>
                <td className="num"><strong>{rupees(order.totalMinor)}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2>Actions</h2>
        <div className="card pad">
          <label htmlFor="reason">Reason (recorded on the audit log)</label>
          <input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you making this change?"
          />

          <div className="btns" style={{ marginTop: 12 }}>
            {nexts.map((to) => (
              <button
                key={to}
                className="btn sm"
                disabled={busy || needsReason}
                onClick={() =>
                  run(`Moved to ${to}`, () =>
                    post(`/orders/${order.id}/change-status`, {
                      field: "fulfillment", to, reason: reason.trim(),
                    }),
                  )
                }
              >
                Mark {to.replace(/_/g, " ").toLowerCase()}
              </button>
            ))}
            {nexts.length === 0 && <span className="muted small">No further fulfilment steps.</span>}
          </div>

          {order.paymentStatus !== "PAID" && order.orderStatus !== "CANCELLED" && (
            <div className="btns" style={{ marginTop: 10 }}>
              <button
                className="btn ghost sm"
                disabled={busy}
                onClick={() => run("Payment link re-issued", () => post(`/orders/${order.id}/send-payment-link`))}
              >
                Re-send payment link
              </button>
            </div>
          )}

          <label htmlFor="rider">Assign rider</label>
          <div className="btns">
            <select id="rider" value={riderId} onChange={(e) => setRiderId(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">Choose a rider…</option>
              {riders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button
              className="btn sm"
              disabled={busy || !riderId}
              onClick={() => run("Rider assigned", () => post(`/orders/${order.id}/assign-rider`, { riderId }))}
            >
              Assign
            </button>
          </div>

          {canCancel && (
            <div className="btns" style={{ marginTop: 16 }}>
              <button
                className="btn danger sm"
                disabled={busy || needsReason}
                onClick={() => {
                  const paid = order.paymentStatus === "PAID";
                  if (paid && !confirm("This order is paid. Cancelling will mark a refund as owed. Continue?")) return;
                  void run("Order cancelled — stock released", () =>
                    post(`/orders/${order.id}/cancel`, {
                      reason: reason.trim(),
                      ...(paid ? { acknowledgeRefundDue: true } : {}),
                    }),
                  );
                }}
              >
                Cancel order
              </button>
              {["PAID", "REFUND_PENDING"].includes(order.paymentStatus) && (
                <button
                  className="btn danger sm"
                  disabled={busy || needsReason}
                  onClick={() =>
                    run("Refund recorded", () =>
                      post(`/orders/${order.id}/refund`, {
                        amountMinor: order.totalMinor, reason: reason.trim(),
                      }),
                    )
                  }
                >
                  Refund in full
                </button>
              )}
            </div>
          )}
        </div>

        <h2>History</h2>
        <div className="card pad">
          <ul className="timeline">
            {order.statusHistory.map((h, n) => (
              <li key={n}>
                <span>
                  <strong>{h.field.replace("_status", "")}</strong>{" "}
                  {h.fromValue ?? "—"} → {h.toValue}
                  {h.reason && <span className="muted"> · {h.reason}</span>}
                </span>
                <span className="muted small" style={{ whiteSpace: "nowrap" }}>
                  {h.actorType.toLowerCase()} · {when(h.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
