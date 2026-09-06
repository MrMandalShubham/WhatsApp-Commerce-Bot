"use client";

import { useCallback, useEffect, useState } from "react";

import { CompleteSheet } from "@/components/CompleteSheet";
import {
  ApiError,
  api,
  getToken,
  rupees,
  setToken,
  type Assignment,
  type CashSummary,
  type CompleteBody,
} from "@/lib/api";
import { useTracking, useWakeLock } from "@/lib/useTracking";

export default function Page() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getToken()));
    setReady(true);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  if (!ready) return <div className="app" />;
  return signedIn ? (
    <Stops onSignOut={() => setSignedIn(false)} />
  ) : (
    <SignIn onDone={() => setSignedIn(true)} />
  );
}

/* ------------------------------------------------------------------ */

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email.trim(), password);
      if (res.user.role !== "RIDER" && res.user.role !== "OWNER" && res.user.role !== "MANAGER") {
        throw new ApiError("This account is not set up for deliveries.", 403);
      }
      setToken(res.accessToken);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app center">
      <h1>Rider</h1>
      <p className="muted">Sign in to see today&rsquo;s deliveries.</p>

      <form onSubmit={submit} style={{ marginTop: 18 }}>
        {error && <div className="alert err">{error}</div>}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button className="btn" type="submit" disabled={busy} style={{ marginTop: 20 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Stops({ onSignOut }: { onSignOut: () => void }) {
  const [stops, setStops] = useState<Assignment[] | null>(null);
  const [cash, setCash] = useState<CashSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<Assignment | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const active = stops?.find((s) => s.status === "OUT_FOR_DELIVERY") ?? null;
  const tracking = useTracking(active?.deliveryId ?? null);
  useWakeLock(Boolean(active));

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api.assignments(), api.cash()]);
      setStops(a);
      setCash(c);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not load deliveries");
      setStops((s) => s ?? []);
    }
  }, [onSignOut]);

  useEffect(() => {
    void load();
    // Cheap poll so a stop assigned at the shop appears without a manual refresh.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function start(s: Assignment) {
    setBusyId(s.deliveryId);
    setError(null);
    try {
      await api.start(
        s.deliveryId,
        tracking.fix
          ? { latitude: tracking.fix.latitude, longitude: tracking.fix.longitude }
          : undefined,
      );
      setFlash(`${s.order.orderNumber} started — the customer can see you now.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the trip");
    } finally {
      setBusyId(null);
    }
  }

  async function complete(body: CompleteBody) {
    if (!finishing) return;
    setBusyId(finishing.deliveryId);
    try {
      await api.complete(finishing.deliveryId, body);
      setFlash(
        body.outcome === "DELIVERED"
          ? `${finishing.order.orderNumber} delivered.`
          : `${finishing.order.orderNumber} marked not delivered.`,
      );
      setFinishing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="who">Today&rsquo;s stops</div>
          <div className="muted small">
            {stops ? `${stops.length} remaining` : "Loading…"}
          </div>
        </div>
        {cash && (
          <div className={`cash-pill${cash.overCeiling ? " over" : ""}`}>
            {rupees(cash.collectedMinor)} in hand
          </div>
        )}
      </header>

      {cash?.overCeiling && (
        <div className="alert warn">
          You are over your cash limit of {rupees(cash.ceilingMinor)}. Settle at the shop
          before taking more cash orders.
        </div>
      )}
      {flash && <div className="alert ok">{flash}</div>}
      {error && <div className="alert err">{error}</div>}

      {active && (
        <div className="gps">
          <span
            className={`dot ${
              tracking.state === "tracking" ? "live" : tracking.state === "denied" ? "bad" : ""
            }`}
          />
          {tracking.state === "denied"
            ? "Location off — the customer cannot see you"
            : tracking.state === "tracking"
              ? `Sharing location · ±${tracking.fix?.accuracyM ?? "–"} m`
              : "Getting your location…"}
        </div>
      )}
      {tracking.state === "denied" && (
        <div className="alert warn">
          Turn on location for this site in your browser settings, then reopen this page.
          Deliveries still work without it — only live tracking stops.
        </div>
      )}

      {stops === null ? null : stops.length === 0 ? (
        <div className="empty">
          <p style={{ fontSize: 40, margin: 0 }}>✓</p>
          <h2 style={{ marginTop: 12 }}>All done</h2>
          <p className="muted">No deliveries assigned right now.</p>
          <button className="btn secondary" onClick={() => void load()} style={{ marginTop: 16 }}>
            Refresh
          </button>
        </div>
      ) : (
        stops.map((s) => (
          <StopCard
            key={s.deliveryId}
            stop={s}
            busy={busyId === s.deliveryId}
            onStart={() => void start(s)}
            onFinish={() => setFinishing(s)}
          />
        ))
      )}

      <button
        className="btn link"
        style={{ marginTop: 24 }}
        onClick={() => {
          setToken(null);
          onSignOut();
        }}
      >
        Sign out
      </button>

      {finishing && (
        <CompleteSheet
          assignment={finishing}
          busy={busyId === finishing.deliveryId}
          onClose={() => setFinishing(null)}
          onSubmit={(b) => void complete(b)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StopCard({
  stop,
  busy,
  onStart,
  onFinish,
}: {
  stop: Assignment;
  busy: boolean;
  onStart: () => void;
  onFinish: () => void;
}) {
  const onTrip = stop.status === "OUT_FOR_DELIVERY";
  const cod = stop.order.collectCashMinor > 0;

  return (
    <section className={`card${onTrip ? " active" : ""}`}>
      <div className="row">
        <span className="order-no">{stop.order.orderNumber}</span>
        {cod ? (
          <span className="chip cash">Collect {rupees(stop.order.collectCashMinor)}</span>
        ) : (
          <span className="chip">Prepaid</span>
        )}
      </div>

      <div className="addr">
        <div style={{ fontWeight: 600 }}>{stop.customer.name ?? "Customer"}</div>
        <div className="muted">{stop.address?.line1 ?? "No address on file"}</div>
        {stop.address?.landmark && (
          <div className="landmark">📍 {stop.address.landmark}</div>
        )}
      </div>

      <ul className="items">
        {stop.order.items.map((i, n) => (
          <li key={n}>
            <span>{i.titleSnapshot}</span>
            <span>×{i.quantity}</span>
          </li>
        ))}
      </ul>

      <div className="stack" style={{ marginTop: 14 }}>
        {stop.address?.mapsUrl && (
          <a
            className="btn secondary"
            href={stop.address.mapsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Navigate
          </a>
        )}
        {onTrip ? (
          <button className="btn" disabled={busy} onClick={onFinish}>
            {busy ? "Saving…" : "Finish delivery"}
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={onStart}>
            {busy ? "Starting…" : "Start delivery"}
          </button>
        )}
      </div>
    </section>
  );
}
