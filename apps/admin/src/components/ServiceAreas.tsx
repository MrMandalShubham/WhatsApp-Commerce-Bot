"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";

import { ApiError, call, del, patch, post, rupees } from "@/lib/api";
import type { ExistingArea } from "@/components/AreaMap";

const AreaMap = dynamic(() => import("@/components/AreaMap").then((m) => m.AreaMap), {
  ssr: false,
  loading: () => <div className="area-map skeleton" />,
});

interface Area extends ExistingArea {
  codAllowed: boolean;
  codMaxOrderMinor: number | null;
  deliveryFeeMinor: number;
  minOrderValueMinor: number;
  areaKm2: number | null;
}

const BLANK = {
  name: "",
  deliveryFee: "30",
  minOrder: "200",
  codMax: "5000",
  codAllowed: true,
  isActive: true,
};

const toMinor = (s: string): number => Math.round(Number(s.replace(/[^0-9.]/g, "") || 0) * 100);

export function ServiceAreas() {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [draft, setDraft] = useState<number[][]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testPoint, setTestPoint] = useState<[number, number] | null>(null);
  const [mode, setMode] = useState<"draw" | "test">("draw");

  const load = useCallback(async () => {
    try {
      setAreas(await call<Area[]>("/service-areas"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not load areas");
      setAreas([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Centre on an existing area if there is one, otherwise Bengaluru.
  const centre: [number, number] = areas?.[0]?.points?.length
    ? [areas[0].points[0][1], areas[0].points[0][0]]
    : [12.9716, 77.5946];

  async function onMapClick(lng: number, lat: number) {
    if (mode === "test") {
      setTestPoint([lat, lng]);
      try {
        const r = await post<{ serviceable: boolean; message: string }>("/service-areas/test", {
          latitude: lat, longitude: lng,
        });
        setTestResult({ ok: r.serviceable, text: r.message });
      } catch (e) {
        setTestResult({ ok: false, text: e instanceof ApiError ? e.message : "Test failed" });
      }
      return;
    }
    setDraft((d) => [...d, [lng, lat]]);
  }

  function startEdit(a: Area) {
    setEditingId(a.id);
    setDraft(a.points);
    setMode("draw");
    setForm({
      name: a.name,
      deliveryFee: (a.deliveryFeeMinor / 100).toFixed(0),
      minOrder: (a.minOrderValueMinor / 100).toFixed(0),
      codMax: a.codMaxOrderMinor == null ? "" : (a.codMaxOrderMinor / 100).toFixed(0),
      codAllowed: a.codAllowed,
      isActive: a.isActive,
    });
  }

  function reset() {
    setEditingId(null);
    setDraft([]);
    setForm({ ...BLANK });
  }

  async function save() {
    if (draft.length < 3) { setErr("Click at least 3 points on the map to close the area."); return; }
    if (form.name.trim().length < 2) { setErr("Give the area a name."); return; }
    setBusy(true); setErr(null);
    const body = {
      name: form.name.trim(),
      points: draft,
      isActive: form.isActive,
      codAllowed: form.codAllowed,
      codMaxOrderMinor: form.codMax.trim() === "" ? null : toMinor(form.codMax),
      deliveryFeeMinor: toMinor(form.deliveryFee),
      minOrderValueMinor: toMinor(form.minOrder),
    };
    try {
      if (editingId) {
        await patch(`/service-areas/${editingId}`, body);
        setMsg(`${body.name} updated`);
      } else {
        await post("/service-areas", body);
        setMsg(`${body.name} created — the shop can now deliver there`);
      }
      reset();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Area) {
    if (!confirm(`Delete "${a.name}"? Orders will no longer be accepted in this area.`)) return;
    setBusy(true); setErr(null);
    try {
      await del(`/service-areas/${a.id}`);
      setMsg(`${a.name} deleted`);
      if (editingId === a.id) reset();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  const noneActive = areas !== null && areas.filter((a) => a.isActive).length === 0;

  return (
    <>
      <h1>Delivery areas</h1>
      <p className="sub">
        Draw where the shop delivers. Everything else — the delivery fee, minimum order
        and COD limit — follows from whichever area contains the customer&rsquo;s pin.
      </p>

      {noneActive && (
        <div className="alert err">
          No active delivery area. Until one exists, every order is handed to a human
          because no address can be confirmed as deliverable.
        </div>
      )}
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert err">{err}</div>}

      <div className="area-layout">
        <div>
          <div className="btns" style={{ marginBottom: 10 }}>
            <button className={mode === "draw" ? "btn sm" : "btn ghost sm"} onClick={() => { setMode("draw"); setTestResult(null); setTestPoint(null); }}>
              Draw area
            </button>
            <button className={mode === "test" ? "btn sm" : "btn ghost sm"}
                    onClick={() => { setMode("test"); setTestResult(null); setMsg(null); setErr(null); }}>
              Test an address
            </button>
            <span className="muted small" style={{ alignSelf: "center" }}>
              {mode === "draw"
                ? "Click the map to place corners, going around the boundary."
                : "Click anywhere to check whether it is deliverable."}
            </span>
          </div>

          <AreaMap
            centre={centre}
            existing={areas ?? []}
            draft={draft}
            editingId={editingId}
            testPoint={testPoint}
            onMapClick={(lng, lat) => void onMapClick(lng, lat)}
          />

          {mode === "test" && testResult && (
            <div className={`alert ${testResult.ok ? "ok" : "err"}`} style={{ marginTop: 12 }}>
              {testResult.text}
            </div>
          )}
        </div>

        <div>
          {mode === "draw" && (
            <div className="card pad">
              <h2 style={{ marginTop: 0 }}>{editingId ? "Edit area" : "New area"}</h2>

              <div className="row" style={{ marginBottom: 10 }}>
                <span className="muted small">
                  {draft.length === 0 ? "No points yet"
                    : `${draft.length} point${draft.length === 1 ? "" : "s"} placed`}
                  {draft.length > 0 && draft.length < 3 && " — need at least 3"}
                </span>
                <span className="btns">
                  <button className="btn ghost sm" disabled={!draft.length}
                          onClick={() => setDraft((d) => d.slice(0, -1))}>Undo</button>
                  <button className="btn ghost sm" disabled={!draft.length}
                          onClick={() => setDraft([])}>Clear</button>
                </span>
              </div>

              <label htmlFor="an">Area name</label>
              <input id="an" value={form.name} placeholder="Zone 1 — Central"
                     onChange={(e) => setForm({ ...form, name: e.target.value })} />

              <label htmlFor="df">Delivery fee (₹)</label>
              <input id="df" inputMode="decimal" value={form.deliveryFee}
                     onChange={(e) => setForm({ ...form, deliveryFee: e.target.value })} />

              <label htmlFor="mo">Minimum order (₹)</label>
              <input id="mo" inputMode="decimal" value={form.minOrder}
                     onChange={(e) => setForm({ ...form, minOrder: e.target.value })} />

              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <input type="checkbox" checked={form.codAllowed} style={{ width: 18, minHeight: 18 }}
                       onChange={(e) => setForm({ ...form, codAllowed: e.target.checked })} />
                <span>Cash on delivery allowed here</span>
              </label>

              {form.codAllowed && (
                <>
                  <label htmlFor="cm">COD limit (₹) <span className="muted">— blank for no limit</span></label>
                  <input id="cm" inputMode="decimal" value={form.codMax}
                         onChange={(e) => setForm({ ...form, codMax: e.target.value })} />
                </>
              )}

              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <input type="checkbox" checked={form.isActive} style={{ width: 18, minHeight: 18 }}
                       onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                <span>Accepting orders</span>
              </label>

              <div className="btns" style={{ marginTop: 18 }}>
                <button className="btn" disabled={busy || draft.length < 3} onClick={() => void save()}>
                  {busy ? "Saving…" : editingId ? "Save changes" : "Create area"}
                </button>
                {editingId && (
                  <button className="btn ghost" onClick={reset} disabled={busy}>Cancel</button>
                )}
              </div>
            </div>
          )}

          <h2>Existing areas</h2>
          {areas === null ? (
            <p className="muted">Loading…</p>
          ) : areas.length === 0 ? (
            <div className="card pad muted">None yet — draw one on the map.</div>
          ) : (
            areas.map((a) => (
              <div key={a.id} className="card pad" style={{ marginBottom: 10 }}>
                <div className="row">
                  <strong>{a.name}</strong>
                  <span className={`chip ${a.isActive ? "ok" : ""}`}>
                    {a.isActive ? "active" : "off"}
                  </span>
                </div>
                <p className="small muted" style={{ margin: "6px 0 0" }}>
                  {a.areaKm2 ? `${a.areaKm2} km² · ` : ""}
                  {a.points.length} points · delivery {rupees(a.deliveryFeeMinor)} ·
                  min {rupees(a.minOrderValueMinor)}
                  <br />
                  {a.codAllowed
                    ? a.codMaxOrderMinor
                      ? `COD up to ${rupees(a.codMaxOrderMinor)}`
                      : "COD, no limit"
                    : "COD not available"}
                </p>
                <div className="btns" style={{ marginTop: 10 }}>
                  <button className="btn ghost sm" onClick={() => startEdit(a)}>Edit shape &amp; rules</button>
                  <button className="btn danger sm" onClick={() => void remove(a)}>Delete</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
