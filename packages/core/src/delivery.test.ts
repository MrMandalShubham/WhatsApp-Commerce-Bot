import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canCarryCod,
  etaMinutes,
  haversineMetres,
  isPositionStale,
  summariseSettlement,
  POSITION_STALE_AFTER_MS,
} from "./delivery";

test("a rider under the cash ceiling can take another COD order", () => {
  const r = canCarryCod({ outstandingMinor: 200000, ceilingMinor: 1000000 }, 58000);
  assert.equal(r.allowed, true);
  assert.equal(r.wouldHoldMinor, 258000);
});

test("a rider is blocked once the order would push them over the ceiling", () => {
  const r = canCarryCod({ outstandingMinor: 980000, ceilingMinor: 1000000 }, 58000);
  assert.equal(r.allowed, false);
  assert.match(r.message ?? "", /10380\.00/);
  assert.match(r.message ?? "", /Settle cash first/);
});

test("landing exactly on the ceiling is allowed", () => {
  assert.equal(
    canCarryCod({ outstandingMinor: 942000, ceilingMinor: 1000000 }, 58000).allowed,
    true,
  );
});

test("a shortfall is recorded, never absorbed", () => {
  const s = summariseSettlement([
    { amountDueMinor: 58000, amountCollectedMinor: 58000 },
    { amountDueMinor: 40000, amountCollectedMinor: 35000 }, // customer was short
  ]);
  assert.equal(s.expectedMinor, 98000);
  assert.equal(s.collectedMinor, 93000);
  assert.equal(s.shortfallMinor, 5000);
});

test("collecting more than due never shows a negative shortfall", () => {
  const s = summariseSettlement([{ amountDueMinor: 10000, amountCollectedMinor: 12000 }]);
  assert.equal(s.shortfallMinor, 0);
});

test("an empty settlement is zero, not NaN", () => {
  assert.deepEqual(summariseSettlement([]), {
    expectedMinor: 0,
    collectedMinor: 0,
    shortfallMinor: 0,
  });
});

test("haversine matches a known short city distance", () => {
  // ~1.1 km apart in central Bengaluru
  const d = haversineMetres({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9816, lng: 77.5946 });
  assert.ok(d > 1050 && d < 1150, `got ${d}`);
});

test("the same point is zero metres away", () => {
  assert.equal(haversineMetres({ lat: 12.97, lng: 77.6 }, { lat: 12.97, lng: 77.6 }), 0);
});

test("ETA grows with distance and is never zero", () => {
  const near = etaMinutes(300);
  const far = etaMinutes(6000);
  assert.ok(near >= 1);
  assert.ok(far > near);
});

test("a position older than the staleness window is not current", () => {
  const now = new Date("2026-09-05T10:00:00Z");
  const fresh = new Date(now.getTime() - 30_000);
  const old = new Date(now.getTime() - POSITION_STALE_AFTER_MS - 1000);
  assert.equal(isPositionStale(fresh, now), false);
  assert.equal(isPositionStale(old, now), true);
});
