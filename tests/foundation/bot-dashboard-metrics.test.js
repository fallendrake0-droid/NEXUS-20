'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { distance3D, formatCountdown, deriveGotoEta, isTelemetryFresh } = require('../../src/dashboard/public/botMetrics');

test('bot metrics compute 3D distance and human-readable arrival countdowns safely', () => {
  assert.equal(distance3D({ x: 0, y: 64, z: 0 }, { x: 3, y: 68, z: 0 }), 5);
  assert.equal(distance3D({ x: 0, y: NaN, z: 0 }, { x: 1, y: 2, z: 3 }), null);
  assert.equal(distance3D({ x: 0, y: null, z: 0 }, { x: 1, y: 2, z: 3 }), null);
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(61.1), '1m 02s');
  assert.equal(formatCountdown(3661), '1h 1m 01s');
  assert.equal(formatCountdown(90_061), '1d 1h 1m');
  assert.equal(formatCountdown(Number.NaN), '—');
});

test('disconnected or old bot telemetry is not presented as current', () => {
  const nowMs = Date.parse('2026-11-10T12:00:00.000Z');
  assert.equal(isTelemetryFresh('ready', '2026-11-10T11:59:55.000Z', nowMs), true);
  assert.equal(isTelemetryFresh('disconnected', '2026-11-10T11:59:55.000Z', nowMs), false);
  assert.equal(isTelemetryFresh('ready', '2026-11-10T11:59:40.000Z', nowMs), false);
  assert.equal(isTelemetryFresh('ready', null, nowMs), false);
});

test('goto ETA requires fresh telemetry and observed movement; no fake arrival estimate', () => {
  const nowMs = 100_000;
  const base = { distance: 30, nowMs, latestTelemetryAtMs: nowMs - 1_000, lastMovedAtMs: nowMs - 1_000 };
  assert.deepEqual(deriveGotoEta({ ...base, speedSamples: [] }), { status: 'sampling', seconds: null, speed: null });
  assert.equal(deriveGotoEta({ ...base, speedSamples: [{ speed: 3, atMs: nowMs - 1_000 }] }).seconds, 10);
  assert.equal(deriveGotoEta({ ...base, distance: 1.4, speedSamples: [] }).status, 'near_target');
  assert.equal(deriveGotoEta({ ...base, latestTelemetryAtMs: nowMs - 20_000, speedSamples: [{ speed: 3, atMs: nowMs }] }).status, 'stale');
  assert.equal(deriveGotoEta({ ...base, lastMovedAtMs: nowMs - 11_000, speedSamples: [{ speed: 3, atMs: nowMs - 11_000 }] }).status, 'stationary');
  assert.equal(deriveGotoEta({ ...base, speedSamples: [{ speed: 40, atMs: nowMs }] }).status, 'sampling');
});
