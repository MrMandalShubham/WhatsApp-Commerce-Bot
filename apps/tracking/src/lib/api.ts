const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export interface Tracking {
  orderNumber: string;
  status: string;
  totalMinor: number;
  rider: { name: string } | null;
  destination: { latitude: number; longitude: number; landmark: string | null } | null;
  riderPosition: { latitude: number; longitude: number; at: string; stale: boolean } | null;
  etaMinutes: number | null;
}

export class TrackError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function fetchTracking(token: string): Promise<Tracking> {
  let res: Response;
  try {
    res = await fetch(`${API}/track/${encodeURIComponent(token)}`, { cache: "no-store" });
  } catch {
    throw new TrackError("Could not reach the server. Check your connection.", 0);
  }
  if (res.status === 404) {
    throw new TrackError("This tracking link has expired or is no longer valid.", 404);
  }
  if (!res.ok) throw new TrackError("Something went wrong. Please try again.", res.status);
  return (await res.json()) as Tracking;
}

export const rupees = (m: number): string =>
  `₹${Math.floor(m / 100)}.${String(m % 100).padStart(2, "0")}`;

export function agoLabel(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 45) return "just now";
  if (secs < 90) return "1 minute ago";
  if (secs < 3600) return `${Math.round(secs / 60)} minutes ago`;
  return `${Math.round(secs / 3600)} hours ago`;
}
