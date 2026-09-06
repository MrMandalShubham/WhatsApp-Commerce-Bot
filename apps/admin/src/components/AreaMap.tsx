"use client";

import { useEffect, useRef } from "react";
import type { Map as LMap, LayerGroup } from "leaflet";

export interface ExistingArea {
  id: string;
  name: string;
  points: number[][]; // [[lng, lat], …]
  isActive: boolean;
}

interface Props {
  centre: [number, number];        // [lat, lng]
  existing: ExistingArea[];
  /** The polygon being drawn, as [[lng, lat], …]. */
  draft: number[][];
  editingId: string | null;
  testPoint: [number, number] | null; // [lat, lng]
  onMapClick: (lng: number, lat: number) => void;
}

/**
 * Leaflet loaded lazily — it reads `window` at import time.
 *
 * Drawing is plain click-to-place rather than Leaflet.draw: one fewer
 * dependency, and placing vertices by tapping is what people expect from
 * every map tool they have used.
 *
 * Tiles are OpenStreetMap, which is fine for internal use but not licensed
 * for production traffic — swap the URL for a paid provider before go-live.
 */
export function AreaMap({ centre, existing, draft, editingId, testPoint, onMapClick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const drawn = useRef<LayerGroup | null>(null);
  const saved = useRef<LayerGroup | null>(null);
  const clickCb = useRef(onMapClick);
  clickCb.current = onMapClick;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el.current || map.current) return;

      map.current = L.map(el.current).setView(centre, 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(map.current);

      saved.current = L.layerGroup().addTo(map.current);
      drawn.current = L.layerGroup().addTo(map.current);

      map.current.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        clickCb.current(e.latlng.lng, e.latlng.lat);
      });
    })();
    return () => {
      cancelled = true;
    };
    // centre is only the initial view; re-centring on every render would fight
    // the operator panning around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved areas
  useEffect(() => {
    void (async () => {
      if (!map.current || !saved.current) return;
      const L = (await import("leaflet")).default;
      saved.current.clearLayers();

      for (const a of existing) {
        if (a.points.length < 3 || a.id === editingId) continue;
        L.polygon(
          a.points.map(([lng, lat]) => [lat, lng] as [number, number]),
          {
            color: a.isActive ? "#0E6B5C" : "#9DB8B1",
            weight: 2,
            fillOpacity: a.isActive ? 0.12 : 0.06,
            dashArray: a.isActive ? undefined : "5,5",
          },
        )
          .bindTooltip(`${a.name}${a.isActive ? "" : " (off)"}`, { sticky: true })
          .addTo(saved.current);
      }
    })();
  }, [existing, editingId]);

  // The polygon currently being drawn, plus a numbered handle per vertex
  useEffect(() => {
    void (async () => {
      if (!map.current || !drawn.current) return;
      const L = (await import("leaflet")).default;
      drawn.current.clearLayers();

      const latlngs = draft.map(([lng, lat]) => [lat, lng] as [number, number]);

      if (latlngs.length >= 3) {
        L.polygon(latlngs, { color: "#F2B705", weight: 3, fillOpacity: 0.2 }).addTo(drawn.current);
      } else if (latlngs.length === 2) {
        L.polyline(latlngs, { color: "#F2B705", weight: 3, dashArray: "6,6" }).addTo(drawn.current);
      }

      latlngs.forEach((p, i) => {
        L.marker(p, {
          icon: L.divIcon({
            className: "",
            html:
              `<span style="display:flex;align-items:center;justify-content:center;` +
              `width:22px;height:22px;border-radius:50%;background:#F2B705;color:#12211E;` +
              `font:700 11px system-ui;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${i + 1}</span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
        }).addTo(drawn.current!);
      });

      if (testPoint) {
        L.marker(testPoint, {
          icon: L.divIcon({
            className: "",
            html:
              `<span style="display:block;width:18px;height:18px;border-radius:50%;` +
              `background:#C4453F;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)"></span>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
        })
          .bindTooltip("Test point", { permanent: false })
          .addTo(drawn.current!);
      }
    })();
  }, [draft, testPoint]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );

  return <div ref={el} className="area-map" />;
}
