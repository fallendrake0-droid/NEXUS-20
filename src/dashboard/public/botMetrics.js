'use strict';

(function attachBotMetrics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusBotMetrics = api;
})(typeof globalThis === 'object' ? globalThis : this, function createBotMetrics() {
  function isFiniteCoordinate(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function distance3D(position, target) {
    if (!position || !target) return null;
    const rawValues = [position.x, position.y, position.z, target.x, target.y, target.z];
    if (!rawValues.every(isFiniteCoordinate)) return null;
    const values = rawValues.map(Number);
    return Math.hypot(values[0] - values[3], values[1] - values[4], values[2] - values[5]);
  }

  function isTelemetryFresh(connectionState, updatedAt, nowMs = Date.now(), maxAgeMs = 15_000) {
    if (connectionState !== 'ready') return false;
    const timestamp = Date.parse(updatedAt || '');
    if (!Number.isFinite(timestamp) || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
    const ageMs = nowMs - timestamp;
    return ageMs >= -5_000 && ageMs <= maxAgeMs;
  }

  function formatCountdown(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
    let seconds = Math.ceil(totalSeconds);
    const days = Math.floor(seconds / 86_400);
    seconds %= 86_400;
    const hours = Math.floor(seconds / 3_600);
    seconds %= 3_600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${String(seconds).padStart(2, '0')}s`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  function deriveGotoEta({ distance, speedSamples = [], nowMs = Date.now(), latestTelemetryAtMs, lastMovedAtMs, maxTelemetryAgeMs = 15_000 }) {
    if (!Number.isFinite(distance) || distance < 0) return { status: 'unknown', seconds: null, speed: null };
    if (distance <= 1.5) return { status: 'near_target', seconds: 0, speed: null };
    if (!Number.isFinite(latestTelemetryAtMs) || nowMs - latestTelemetryAtMs > maxTelemetryAgeMs) {
      return { status: 'stale', seconds: null, speed: null };
    }
    if (Number.isFinite(lastMovedAtMs) && nowMs - lastMovedAtMs > 10_000) {
      return { status: 'stationary', seconds: null, speed: null };
    }
    const recentSpeeds = speedSamples
      .filter((sample) => sample && Number.isFinite(sample.speed) && sample.speed >= 0.15 && sample.speed <= 10 &&
        Number.isFinite(sample.atMs) && nowMs - sample.atMs <= 30_000)
      .map((sample) => sample.speed)
      .sort((a, b) => a - b);
    if (recentSpeeds.length === 0) return { status: 'sampling', seconds: null, speed: null };
    const middle = Math.floor(recentSpeeds.length / 2);
    const speed = recentSpeeds.length % 2
      ? recentSpeeds[middle]
      : (recentSpeeds[middle - 1] + recentSpeeds[middle]) / 2;
    return { status: 'estimated', seconds: distance / speed, speed };
  }

  return { distance3D, formatCountdown, deriveGotoEta, isTelemetryFresh };
});
