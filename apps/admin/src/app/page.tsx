"use client";

import { useCallback, useEffect, useState } from "react";

import { OrderDrawer } from "@/components/OrderDrawer";
import { ProductForm } from "@/components/ProductForm";
import { ServiceAreas } from "@/components/ServiceAreas";
import { Riders } from "@/components/Riders";
import {
  ApiError, call, getToken, post, rupees, setToken, setUnauthorizedHandler, when,
  type Overview, type OrderRow, type ProductRow, type RiderRow,
} from "@/lib/api";

type Tab = "dashboard" | "orders" | "products" | "areas" | "riders" | "ops";
const TABS: Array<[Tab, string]> = [
  ["dashboard", "Dashboard"],
  ["orders", "Orders"],
  ["products", "Products"],
  ["areas", "Delivery areas"],
  ["riders", "Riders & cash"],
  ["ops", "Operations"],
];

export default function Page() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    setUnauthorizedHandler(() => setSignedIn(false));
    setSignedIn(Boolean(getToken()));
    setReady(true);
  }, []);

  if (!ready) return null;
  return signedIn ? (
    <Shell email={email} onSignOut={() => { setToken(null); setSignedIn(false); }} />
  ) : (
    <Login onDone={(e) => { setEmail(e); setSignedIn(true); }} />
  );
}

/* ------------------------------------------------------------------ */

function Login({ onDone }: { onDone: (email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ accessToken: string; user: { role: string } }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password }),
        auth: false,
      });
      if (r.user.role === "RIDER") {
        throw new ApiError("Rider accounts use the rider app, not the admin panel.", 403);
      }
      setToken(r.accessToken);
      onDone(email.trim());
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="main login">
      <h1>Shop admin</h1>
      <p className="sub">Sign in to manage orders, products and deliveries.</p>
      <form onSubmit={submit} className="card pad">
        {error && <div className="alert err">{error}</div>}
        <label htmlFor="e">Email</label>
        <input id="e" type="email" autoComplete="username" value={email}
               onChange={(ev) => setEmail(ev.target.value)} required />
        <label htmlFor="p">Password</label>
        <input id="p" type="password" autoComplete="current-password" value={password}
               onChange={(ev) => setPassword(ev.target.value)} required />
        <button className="btn" style={{ width: "100%", marginTop: 16 }} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function Shell({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Shop admin</div>
        <div className="who">{email || "signed in"}</div>
        <nav>
          {TABS.map(([id, label]) => (
            <button key={id} aria-current={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <button className="side out" style={{ background: "none", border: 0, cursor: "pointer" }}
                onClick={onSignOut}>
          Sign out
        </button>
      </aside>
      <main className="main">
        {tab === "dashboard" && <Dashboard />}
        {tab === "orders" && <Orders />}
        {tab === "products" && <Products />}
        {tab === "areas" && <ServiceAreas />}
        {tab === "riders" && <Riders />}
        {tab === "ops" && <Ops />}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Dashboard() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { setD(await call<Overview>("/reports/overview?days=30")); }
      catch (e) { setErr(e instanceof ApiError ? e.message : "Could not load"); }
    })();
  }, []);

  if (err) return <div className="alert err">{err}</div>;
  if (!d) return <p className="muted">Loading…</p>;

  const a = d.attention;
  // Only the counters that mean "someone must act" get the amber treatment.
  const flags: Array<[string, number]> = [
    ["Awaiting payment", a.awaitingPayment],
    ["Failed payments", a.failedPayments],
    ["Riders on trip", a.ridersOnTrip],
    ["Stuck webhooks", a.stuckWebhooks],
    ["Failed sends", a.failedMessageSends],
    ["Low stock", a.lowStockProducts],
  ];

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">Today, and the last 30 days.</p>

      <div className="stats">
        <div className="stat"><div className="k">Orders today</div><div className="v">{d.today.orders}</div></div>
        <div className="stat"><div className="k">Revenue today</div><div className="v">{rupees(d.today.revenueMinor)}</div></div>
        <div className="stat"><div className="k">Orders / 30d</div><div className="v">{d.period.orders}</div></div>
        <div className="stat"><div className="k">Avg order</div><div className="v">{rupees(d.period.averageOrderMinor)}</div></div>
      </div>

      <h2>Needs attention</h2>
      <div className="stats">
        {flags.map(([k, v]) => (
          <div key={k} className={`stat${v > 0 && k !== "Riders on trip" ? " alert-on" : ""}`}>
            <div className="k">{k}</div>
            <div className="v">{v}</div>
          </div>
        ))}
      </div>

      <h2>Fulfilment</h2>
      <div className="card pad">
        {Object.entries(d.fulfillment).length === 0 ? (
          <span className="muted">No orders in this period.</span>
        ) : (
          <div className="btns">
            {Object.entries(d.fulfillment).map(([k, v]) => (
              <span key={k} className="chip">{k.replace(/_/g, " ").toLowerCase()} · {v}</span>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */

function Orders() {
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [riders, setRiders] = useState<Array<{ id: string; name: string }>>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [fulfillment, setFulfillment] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (status) qs.set("status", status);
      if (fulfillment) qs.set("fulfillment", fulfillment);
      if (phone.trim()) qs.set("phone", phone.trim());
      const r = await call<{ data: OrderRow[] }>(`/orders?${qs}`);
      setRows(r.data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load orders");
      setRows([]);
    }
  }, [status, fulfillment, phone]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try { setRiders(await call<RiderRow[]>("/reports/riders?days=90")); } catch { /* non-fatal */ }
    })();
  }, []);

  return (
    <>
      <h1>Orders</h1>
      <p className="sub">Newest first. Click a row to open it.</p>

      <div className="filters">
        <div>
          <label htmlFor="s">Order status</label>
          <select id="s" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {["PLACED", "CONFIRMED", "COMPLETED", "CANCELLED"].map((v) => <option key={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f">Fulfilment</label>
          <select id="f" value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
            <option value="">Any</option>
            {["UNFULFILLED", "CONFIRMED", "PACKED", "ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED_DELIVERY"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ph">Customer phone</label>
          <input id="ph" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9198…" />
        </div>
        <button className="btn ghost" onClick={() => void load()}>Refresh</button>
      </div>

      {err && <div className="alert err">{err}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Status</th><th>Pay</th>
              <th>Rider</th><th className="num">Items</th><th className="num">Total</th><th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={8} className="empty">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="empty">No orders match these filters.</td></tr>
            ) : (
              rows.map((o) => (
                <tr key={o.id} className="click" onClick={() => setOpenId(o.id)}>
                  <td className="mono"><strong>{o.orderNumber}</strong></td>
                  <td>{o.customer.name ?? o.customer.waPhone}</td>
                  <td>
                    <span className={`chip ${
                      o.orderStatus === "CANCELLED" ? "bad"
                      : o.displayStatus === "Delivered" ? "ok"
                      : o.displayStatus.includes("Awaiting") || o.displayStatus.includes("failed") ? "warn" : ""
                    }`}>{o.displayStatus}</span>
                  </td>
                  <td className="small">{o.paymentMode}</td>
                  <td className="small">{o.rider?.name ?? "—"}</td>
                  <td className="num">{o.itemCount}</td>
                  <td className="num">{rupees(o.totalMinor)}</td>
                  <td className="small muted">{when(o.placedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openId && (
        <OrderDrawer
          orderId={openId}
          riders={riders.map((r) => ({ id: r.id, name: r.name }))}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Products() {
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; product: ProductRow | null }>({
    open: false, product: null,
  });

  const load = useCallback(async () => {
    try { setRows((await call<{ data: ProductRow[] }>("/products?limit=100")).data); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Could not load"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function adjust(p: ProductRow) {
    const raw = prompt(`Stock change for ${p.title} (e.g. 50 or -3)`, "");
    if (raw === null) return;
    const delta = Number(raw);
    if (!Number.isInteger(delta) || delta === 0) { setErr("Enter a whole number, not zero."); return; }
    const reason = prompt("Reason (required — goes on the audit log)", "");
    if (!reason || reason.trim().length < 3) { setErr("A reason is required."); return; }
    try {
      await post(`/products/${p.id}/stock`, { delta, reason: reason.trim() });
      setMsg(`${p.title}: stock changed by ${delta}`);
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Adjustment failed");
    }
  }

  return (
    <>
      <div className="drawer-head">
        <div>
          <h1>Products</h1>
          <p className="sub" style={{ margin: 0 }}>
            Stock changes are recorded with a reason.
          </p>
        </div>
        <button className="btn" onClick={() => setForm({ open: true, product: null })}>
          + New product
        </button>
      </div>
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert err">{err}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Product</th><th>SKU</th><th>Category</th><th className="num">Price</th>
              <th className="num">GST</th><th className="num">On hand</th><th className="num">Held</th>
              <th className="num">Available</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              <tr><td colSpan={9} className="empty">Loading…</td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ whiteSpace: "normal" }}>
                    {p.title}{!p.isActive && <span className="chip bad" style={{ marginLeft: 8 }}>inactive</span>}
                  </td>
                  <td className="mono small">{p.sku}</td>
                  <td className="small muted">{p.category?.name ?? "—"}</td>
                  <td className="num">{rupees(p.priceMinor)}</td>
                  <td className="num">{p.gstRate}%</td>
                  <td className="num">{p.stock?.onHand ?? "—"}</td>
                  <td className="num muted">{p.stock?.reserved ?? 0}</td>
                  <td className="num">
                    <strong className={p.stock && p.stock.available <= 5 ? "warn" : ""}>
                      {p.stock?.available ?? "—"}
                    </strong>
                  </td>
                  <td>
                    <div className="btns">
                      <button className="btn ghost sm" onClick={() => void adjust(p)}>Stock</button>
                      <button className="btn ghost sm"
                              onClick={() => setForm({ open: true, product: p })}>Edit</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {form.open && (
        <ProductForm
          product={form.product}
          onClose={() => setForm({ open: false, product: null })}
          onSaved={(m) => { setMsg(m); setErr(null); void load(); }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Ops() {
  const [queues, setQueues] = useState<Array<{ queue: string; waiting: number; active: number; failed: number }> | null>(null);
  const [hooks, setHooks] = useState<Array<{ id: string; provider: string; receivedAt: string; attempts: number; error: string | null }> | null>(null);
  const [audit, setAudit] = useState<Array<{ occurredAt: string; actor: string; action: string; target: string; reason: string | null }> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, h, a] = await Promise.all([
        call<typeof queues>("/ops/queues"),
        call<{ data: NonNullable<typeof hooks> }>("/ops/webhooks?state=all&limit=15"),
        call<NonNullable<typeof audit>>("/ops/audit?limit=15"),
      ]);
      setQueues(q); setHooks(h.data); setAudit(a); setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function replay(id: string) {
    try {
      await post(`/ops/webhooks/${id}/replay`);
      setMsg("Event queued for replay.");
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Replay failed");
    }
  }

  return (
    <>
      <h1>Operations</h1>
      <p className="sub">Queues, provider events and the audit trail.</p>
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert err">{err}</div>}

      <div className="stats">
        {(queues ?? []).map((q) => (
          <div key={q.queue} className={`stat${q.failed > 0 ? " alert-on" : ""}`}>
            <div className="k">{q.queue.replace(/-/g, " ")}</div>
            <div className="v">{q.waiting + q.active}</div>
            <div className="small muted">{q.failed} dead-lettered</div>
          </div>
        ))}
      </div>

      <h2>Recent provider events</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Provider</th><th>Received</th><th className="num">Attempts</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {(hooks ?? []).map((h) => (
              <tr key={h.id}>
                <td>{h.provider}</td>
                <td className="small muted">{when(h.receivedAt)}</td>
                <td className="num">{h.attempts}</td>
                <td className="small" style={{ whiteSpace: "normal" }}>{h.error ?? "—"}</td>
                <td><button className="btn ghost sm" onClick={() => void replay(h.id)}>Replay</button></td>
              </tr>
            ))}
            {hooks?.length === 0 && <tr><td colSpan={5} className="empty">Nothing recorded.</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Audit trail</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Reason</th></tr></thead>
          <tbody>
            {(audit ?? []).map((a, n) => (
              <tr key={n}>
                <td className="small muted">{when(a.occurredAt)}</td>
                <td className="small">{a.actor}</td>
                <td className="small"><strong>{a.action}</strong></td>
                <td className="small mono">{a.target.slice(0, 28)}</td>
                <td className="small" style={{ whiteSpace: "normal" }}>{a.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
