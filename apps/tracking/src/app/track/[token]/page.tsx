"use client";

import { use, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";

import { agoLabel, fetchTracking, rupees, TrackError, type Tracking } from "@/lib/api";

const Map = dynamic(() => import("@/components/Map").then((m) => m.Map), {
  ssr: false,
  loading: () => <div className="map skeleton" />,
});

const POLL_MS = 10_000;

const STEPS = ["Confirmed", "Packed", "Out for delivery", "Delivered"];

/** Maps the API's derived label onto the progress bar. -1 = not started. */
function stepIndex(status: string): number {
  const s = status.toLowerCase();
  if (s.includes("delivered") && !s.includes("failed")) return 3;
  if (s.includes("out for delivery")) return 2;
  if (s.includes("packed") || s.includes("ready")) return 1;
  if (s.includes("confirmed") || s.includes("received")) return 0;
  return -1;
}

export default function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState<{ message: string; gone: boolean } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchTracking(token));
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      const e = err as TrackError;
      setError({ message: e.message, gone: e.status === 404 });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stop polling once the link is dead or the order is complete - there is
  // nothing further to see and the customer's battery is not ours to spend.
  const finished = data ? stepIndex(data.status) === 3 : false;
  useEffect(() => {
    if (error?.gone || finished) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [error?.gone, finished, load]);

  if (error?.gone) {
    return (
      <main className="wrap center">
        <div className="card pad">
          <h1>Link expired</h1>
          <p className="muted">
            {error.message} If your order is still on the way, check the latest message
            in your WhatsApp chat with the shop.
          </p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="wrap center">
        <div className="card pad">
          {error ? (
            <>
              <h1>Can&rsquo;t load right now</h1>
              <p className="muted">{error.message}</p>
              <button className="btn" onClick={() => void load()}>
                Try again
              </button>
            </>
          ) : (
            <p className="muted">Loading your delivery…</p>
          )}
        </div>
      </main>
    );
  }

  const step = stepIndex(data.status);
  const pos = data.riderPosition;

  return (
    <main className="wrap">
      <header className="head">
        <div>
          <div className="order">{data.orderNumber}</div>
          <h1>{data.status}</h1>
        </div>
        <div className="amount">{rupees(data.totalMinor)}</div>
      </header>

      {step === 2 && (
        <div className={`eta${pos?.stale ? " muted-box" : ""}`}>
          {data.etaMinutes != null ? (
            <>
              <span className="eta-num">{data.etaMinutes}</span>
              <span className="eta-unit">min away</span>
            </>
          ) : (
            <span className="eta-unit">
              {pos?.stale ? "Waiting for a fresh location…" : "On the way"}
            </span>
          )}
        </div>
      )}

      {data.destination && (
        <div className="card">
          <Map
            destination={data.destination}
            rider={pos ? { latitude: pos.latitude, longitude: pos.longitude } : null}
            stale={pos?.stale ?? true}
          />
          <div className="pad-sm">
            {pos ? (
              <p className={`small ${pos.stale ? "warn" : "ok"}`}>
                {pos.stale
                  ? `Last seen ${agoLabel(pos.at)} — the rider may be in a weak signal area.`
                  : `Live · updated ${agoLabel(pos.at)}`}
              </p>
            ) : (
              <p className="small muted">
                {step >= 2
                  ? "The rider has not shared a location yet."
                  : "Live tracking starts when the rider leaves the shop."}
              </p>
            )}
            {data.destination.landmark && (
              <p className="small muted">Delivering to: {data.destination.landmark}</p>
            )}
          </div>
        </div>
      )}

      <ol className="steps" aria-label="Order progress">
        {STEPS.map((label, i) => (
          <li key={label} className={i <= step ? "done" : ""} aria-current={i === step}>
            <span className="bullet" aria-hidden="true" />
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <div className="card pad">
        <div className="row">
          <span className="muted">Rider</span>
          <strong>{data.rider?.name ?? "Not assigned yet"}</strong>
        </div>
        <div className="row">
          <span className="muted">Order total</span>
          <strong>{rupees(data.totalMinor)}</strong>
        </div>
      </div>

      <p className="foot small muted">
        {finished
          ? "This order is complete."
          : updatedAt
            ? `Updates automatically · last checked ${agoLabel(new Date(updatedAt).toISOString())}`
            : ""}
      </p>
    </main>
  );
}
