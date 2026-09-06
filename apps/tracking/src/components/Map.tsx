"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";

interface Props {
  destination: { latitude: number; longitude: number };
  rider: { latitude: number; longitude: number } | null;
  stale: boolean;
}

/**
 * Leaflet loaded lazily on the client - it touches `window` at import time and
 * cannot be server-rendered.
 *
 * Tiles come from OpenStreetMap, which is fine for development but is NOT
 * licensed for production traffic. Swap in a paid tile provider (Mapbox,
 * MapTiler, Google) before go-live; only the URL below changes.
 */
export function Map({ destination, rider, stale }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const riderMarker = useRef<Marker | null>(null);
  const destMarker = useRef<Marker | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el.current || map.current) return;

      map.current = L.map(el.current, {
        zoomControl: false,
        attributionControl: true,
      }).setView([destination.latitude, destination.longitude], 15);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap",
      }).addTo(map.current);

      const pin = (color: string, ring: string) =>
        L.divIcon({
          className: "",
          html: `<span style="display:block;width:20px;height:20px;border-radius:50%;
                 background:${color};border:3px solid ${ring};
                 box-shadow:0 2px 8px rgba(0,0,0,.35)"></span>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        });

      destMarker.current = L.marker([destination.latitude, destination.longitude], {
        icon: pin("#F2B705", "#ffffff"),
        title: "Your address",
      }).addTo(map.current);
    })();

    return () => {
      cancelled = true;
    };
  }, [destination.latitude, destination.longitude]);

  // Move the rider marker as new positions arrive, and keep both pins in view.
  useEffect(() => {
    void (async () => {
      if (!map.current || !rider) return;
      const L = (await import("leaflet")).default;

      const icon = L.divIcon({
        className: "",
        html: `<span style="display:block;width:22px;height:22px;border-radius:50%;
               background:${stale ? "#9DB8B1" : "#17A38C"};border:3px solid #fff;
               box-shadow:0 2px 10px rgba(0,0,0,.4)"></span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });

      if (riderMarker.current) {
        riderMarker.current.setLatLng([rider.latitude, rider.longitude]);
        riderMarker.current.setIcon(icon);
      } else {
        riderMarker.current = L.marker([rider.latitude, rider.longitude], {
          icon,
          title: "Rider",
        }).addTo(map.current);
      }

      map.current.fitBounds(
        L.latLngBounds(
          [destination.latitude, destination.longitude],
          [rider.latitude, rider.longitude],
        ),
        { padding: [56, 56], maxZoom: 16 },
      );
    })();
  }, [rider, stale, destination.latitude, destination.longitude]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );

  return <div ref={el} className="map" aria-label="Delivery map" role="img" />;
}
