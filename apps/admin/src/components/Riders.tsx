"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, call, patch, post, rupees, when } from "@/lib/api";

interface Rider {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  vehicleType: string | null;
  isActive: boolean;
  canSignIn: boolean;
  lastLoginAt: string | null;
  cashCeilingMinor: number;
  cashOutstandingMinor: number;
  overCeiling: boolean;
  openStops: number;
  totalDeliveries: number;
}

interface Credentials {
  name: string;
  email: string;
  password: string;
  isReset: boolean;
}

const BLANK = { name: "", phone: "", email: "", vehicle: "bike", ceiling: "10000", password: "" };

const toMinor = (s: string): number => Math.round(Number(s.replace(/[^0-9.]/g, "") || 0) * 100);

export function Riders() {
  const [riders, setRiders] = useState<Rider[] | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState<Rider | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRiders(await call<Rider[]>("/riders"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load riders");
      setRiders([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function startNew() {
    setEditing(null);
    setForm({ ...BLANK });
    setShowForm(true);
    setCreds(null);
  }

  function startEdit(r: Rider) {
    setEditing(r);
    setForm({
      name: r.name,
      phone: r.phone,
      email: r.email ?? "",
      vehicle: r.vehicleType ?? "",
      ceiling: (r.cashCeilingMinor / 100).toFixed(0),
      password: "",
    });
    setShowForm(true);
    setCreds(null);
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (editing) {
        await patch(`/riders/${editing.id}`, {
          name: form.name.trim(),
          phone: form.phone.trim(),
          vehicleType: form.vehicle.trim(),
          cashCeilingMinor: toMinor(form.ceiling),
        });
        setMsg(`${form.name.trim()} updated`);
        setShowForm(false);
      } else {
        const r = await post<{ name: string; email: string; password: string }>("/riders", {
          name: form.name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          vehicleType: form.vehicle.trim() || undefined,
          cashCeilingMinor: toMinor(form.ceiling),
          ...(form.password.trim() ? { password: form.password.trim() } : {}),
        });
        // Shown once — there is no way to read it back.
        setCreds({ name: r.name, email: r.email, password: r.password, isReset: false });
        setShowForm(false);
      }
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(r: Rider) {
    setBusy(true); setErr(null);
    try {
      await patch(`/riders/${r.id}`, {
        isActive: !r.isActive,
        reason: r.isActive ? "switched off from the admin panel" : "switched on again",
      });
      setMsg(`${r.name} ${r.isActive ? "switched off" : "switched on"}`);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not change the rider");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(r: Rider) {
    if (!confirm(`Issue a new password for ${r.name}? Their current one stops working immediately.`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await post<{ email: string; password: string }>(`/riders/${r.id}/reset-password`, {});
      setCreds({ name: r.name, email: res.email, password: res.password, isReset: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not reset the password");
    } finally {
      setBusy(false);
    }
  }

  async function settle(r: Rider) {
    const raw = prompt(
      `${r.name} is holding ${rupees(r.cashOutstandingMinor)}.\nHow much cash did you receive? (₹)`,
      (r.cashOutstandingMinor / 100).toFixed(2),
    );
    if (raw === null) return;
    const receivedMinor = toMinor(raw);
    setBusy(true); setErr(null);
    try {
      const s = await post<{ shortfallMinor: number }>("/rider/cash/settle", {
        riderId: r.id, receivedMinor, note: "counted at shop",
      });
      setMsg(
        s.shortfallMinor > 0
          ? `Settled with ${r.name}. Short by ${rupees(s.shortfallMinor)} — recorded.`
          : `Settled with ${r.name} in full.`,
      );
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Settlement failed");
    } finally {
      setBusy(false);
    }
  }

  const valid =
    form.name.trim().length >= 2 &&
    form.phone.replace(/\D/g, "").length >= 10 &&
    (editing !== null || /^\S+@\S+\.\S+$/.test(form.email.trim()));

  return (
    <>
      <div className="drawer-head">
        <div>
          <h1>Riders &amp; cash</h1>
          <p className="sub" style={{ margin: 0 }}>
            Each rider gets a sign-in for the rider app at port 3001.
          </p>
        </div>
        <button className="btn" onClick={startNew}>+ New rider</button>
      </div>

      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert err">{err}</div>}

      {/* Credentials appear once. There is no way to read the password back. */}
      {creds && (
        <div className="card pad" style={{ borderColor: "var(--emerald)", marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>
            {creds.isReset ? `New password for ${creds.name}` : `${creds.name} can now sign in`}
          </h2>
          <p className="small muted">
            Give these to the rider now — the password is hashed and cannot be shown again.
            They sign in at <strong>the rider app</strong>, not this panel.
          </p>
          <dl className="kv" style={{ margin: "12px 0" }}>
            <dt>Email</dt><dd className="mono"><strong>{creds.email}</strong></dd>
            <dt>Password</dt><dd className="mono"><strong>{creds.password}</strong></dd>
          </dl>
          <div className="btns">
            <button className="btn ghost sm"
                    onClick={() => void navigator.clipboard?.writeText(
                      `Rider app sign-in\nEmail: ${creds.email}\nPassword: ${creds.password}`)}>
              Copy
            </button>
            <button className="btn sm" onClick={() => setCreds(null)}>Done, I&rsquo;ve saved it</button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="card pad" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>{editing ? `Edit ${editing.name}` : "New rider"}</h2>

          <label htmlFor="rn">Name</label>
          <input id="rn" value={form.name} placeholder="Ravi Kumar"
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />

          <label htmlFor="rp">Phone</label>
          <input id="rp" value={form.phone} placeholder="9812345678" inputMode="tel"
                 onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <p className="small muted" style={{ marginTop: 4 }}>
            A 10-digit number is treated as Indian and stored as +91…
          </p>

          {!editing && (
            <>
              <label htmlFor="re">Sign-in email</label>
              <input id="re" type="email" value={form.email} placeholder="ravi@shop.local"
                     onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <p className="small muted" style={{ marginTop: 4 }}>
                Does not need to be a real inbox — it is only a username.
              </p>

              <label htmlFor="rw">Password <span className="muted">— leave blank to generate one</span></label>
              <input id="rw" value={form.password} placeholder="auto-generated"
                     onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </>
          )}

          <label htmlFor="rv">Vehicle</label>
          <input id="rv" value={form.vehicle} placeholder="bike"
                 onChange={(e) => setForm({ ...form, vehicle: e.target.value })} />

          <label htmlFor="rc">Cash limit (₹)</label>
          <input id="rc" inputMode="decimal" value={form.ceiling}
                 onChange={(e) => setForm({ ...form, ceiling: e.target.value })} />
          <p className="small muted" style={{ marginTop: 4 }}>
            Once undeposited cash passes this, the rider stops being assigned COD orders.
          </p>

          <div className="btns" style={{ marginTop: 18 }}>
            <button className="btn" disabled={busy || !valid} onClick={() => void save()}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create rider"}
            </button>
            <button className="btn ghost" onClick={() => setShowForm(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Rider</th><th>Sign-in</th><th className="num">Open stops</th>
              <th className="num">Delivered</th><th className="num">Cash held</th>
              <th className="num">Limit</th><th>Last seen</th><th></th>
            </tr>
          </thead>
          <tbody>
            {riders === null ? (
              <tr><td colSpan={8} className="empty">Loading…</td></tr>
            ) : riders.length === 0 ? (
              <tr><td colSpan={8} className="empty">
                No riders yet. Add one so orders can be assigned.
              </td></tr>
            ) : (
              riders.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    {!r.isActive && <span className="chip" style={{ marginLeft: 8 }}>off</span>}
                    <br />
                    <span className="small muted mono">{r.phone}</span>
                    {r.vehicleType && <span className="small muted"> · {r.vehicleType}</span>}
                  </td>
                  <td className="small mono">{r.email ?? <span className="chip bad">none</span>}</td>
                  <td className="num">{r.openStops > 0 ? <strong>{r.openStops}</strong> : "—"}</td>
                  <td className="num">{r.totalDeliveries}</td>
                  <td className="num">
                    <span className={r.overCeiling ? "chip bad" : ""}>
                      {rupees(r.cashOutstandingMinor)}
                    </span>
                  </td>
                  <td className="num muted">{rupees(r.cashCeilingMinor)}</td>
                  <td className="small muted">{r.lastLoginAt ? when(r.lastLoginAt) : "never"}</td>
                  <td>
                    <div className="btns">
                      <button className="btn ghost sm" onClick={() => startEdit(r)}>Edit</button>
                      <button className="btn ghost sm" disabled={busy}
                              onClick={() => void resetPassword(r)}>Password</button>
                      <button className="btn sm" disabled={busy || r.cashOutstandingMinor === 0}
                              onClick={() => void settle(r)}>Settle</button>
                      <button className="btn ghost sm" disabled={busy}
                              onClick={() => void toggleActive(r)}>
                        {r.isActive ? "Switch off" : "Switch on"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
