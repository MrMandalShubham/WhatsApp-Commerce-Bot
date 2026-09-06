"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";

const PING_INTERVAL_MS = 12_000;

export interface Fix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  at: number;
}

export type GpsState = "idle" | "requesting" | "tracking" | "denied" | "unavailable";

/**
 * Watches the device position while a trip is active and forwards a fix to
 * the API at most every PING_INTERVAL_MS.
 *
 * Throttling here rather than in the browser is deliberate: watchPosition
 * fires far more often than we need, and each ping is a request on a rider's
 * mobile data. The last fix is always kept locally so the UI can show
 * accuracy even between sends.
 */
export function useTracking(deliveryId: string | null) {
  const [state, setState] = useState<GpsState>("idle");
  const [fix, setFix] = useState<Fix | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const watchId = useRef<number | null>(null);
  const lastSend = useRef(0);
  const sending = useRef(false);

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setState("idle");
  }, []);

  useEffect(() => {
    if (!deliveryId) {
      stop();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("unavailable");
      return;
    }

    setState("requesting");
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setState("tracking");
        setError(null);
        const next: Fix = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
          at: Date.now(),
        };
        setFix(next);

        const now = Date.now();
        if (now - lastSend.current < PING_INTERVAL_MS || sending.current) return;
        lastSend.current = now;
        sending.current = true;

        api
          .ping({
            latitude: next.latitude,
            longitude: next.longitude,
            accuracyM: next.accuracyM,
            deliveryId,
          })
          .then(() => setLastSentAt(Date.now()))
          // A dropped ping is not worth interrupting the rider over; the next
          // one will land. Only a persistent failure surfaces, via staleness.
          .catch(() => undefined)
          .finally(() => {
            sending.current = false;
          });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setState("denied");
          setError("Location permission is off. The customer cannot see you on the map.");
        } else {
          setState("tracking");
          setError("Weak GPS signal.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );

    return stop;
  }, [deliveryId, stop]);

  return { state, fix, lastSentAt, error };
}

/** Keeps the screen awake during a trip, where the browser allows it. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> };
    };
    if (!nav.wakeLock) return;

    let lock: { release(): Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const l = await nav.wakeLock!.request("screen");
        if (cancelled) void l.release();
        else lock = l;
      } catch {
        /* denied or unsupported - not worth telling the rider about */
      }
    };
    void acquire();

    // A wake lock is dropped when the tab is backgrounded; re-acquire on return.
    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, [active]);
}
