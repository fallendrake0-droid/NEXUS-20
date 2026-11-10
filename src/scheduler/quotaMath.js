'use strict';

const { DomainError } = require('../errors/DomainError');

/**
 * Water-filling makespan-equalizing quota splitter (TASK_ALLOCATION.md §6 & HIGH-03 fix).
 *
 * Solves for common completion horizon `T*` across selected candidates `b_k`:
 *   sum_{k=1..p} r_k * (T* - F_k) = remainingQuantity, with T* > F_p
 * where `F_k = travelSec + setupSec` and `r_k = max(0.05, rateUnitsPerSec)`.
 * Automatically prunes trailing candidates whose arrival time `F_k >= T*` exceeds the
 * swarm's finish horizon, and rounds via largest-remainder so `sum(q_k) === remainingQuantity`.
 *
 * @param {number} remainingQuantity
 * @param {Array<{ botId: string, workerId: string, rateP50?: number, travelSec?: number, setupSec?: number, role?: string | null }>} candidates
 * @returns {Array<{ botId: string, workerId: string, quantity: number, partitionId: null, regionBounds: null, role: string | null }>}
 */
function splitQuota(remainingQuantity, candidates) {
  if (!Number.isSafeInteger(remainingQuantity) || remainingQuantity < 0) {
    throw new DomainError('SCHEMA_VALIDATION_FAILED', 'remainingQuantity must be a safe integer >= 0');
  }
  if (remainingQuantity === 0 || !Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const normalized = candidates.map((c) => ({
    botId: String(c.botId),
    workerId: String(c.workerId || 'unknown'),
    rate: Math.max(0.05, Number.isFinite(c.rateP50) && c.rateP50 > 0 ? c.rateP50 : 0.25),
    fixedDelay: Math.max(
      0,
      (Number.isFinite(c.travelSec) ? c.travelSec : 0) +
        (Number.isFinite(c.setupSec) ? c.setupSec : 0)
    ),
    role: c.role || null
  }));

  // Sort ascending by startup delay F_k; tie-break by faster rate, then botId
  normalized.sort((a, b) => {
    if (a.fixedDelay !== b.fixedDelay) return a.fixedDelay - b.fixedDelay;
    if (b.rate !== a.rate) return b.rate - a.rate;
    return a.botId.localeCompare(b.botId);
  });

  // Never select more bots than remaining integer units (every selected bot gets >= 1)
  const capped = normalized.slice(0, Math.min(normalized.length, remainingQuantity));

  // Water-filling prefix search: find largest p >= 1 where T*_p > F_{p-1}
  let activePrefix = 1;
  let bestHorizon = (remainingQuantity + capped[0].rate * capped[0].fixedDelay) / capped[0].rate;

  let sumRate = capped[0].rate;
  let sumRateDelay = capped[0].rate * capped[0].fixedDelay;
  for (let i = 1; i < capped.length; i += 1) {
    const nextSumRate = sumRate + capped[i].rate;
    const nextSumRateDelay = sumRateDelay + capped[i].rate * capped[i].fixedDelay;
    const trialHorizon = (remainingQuantity + nextSumRateDelay) / nextSumRate;
    if (trialHorizon > capped[i].fixedDelay) {
      sumRate = nextSumRate;
      sumRateDelay = nextSumRateDelay;
      activePrefix = i + 1;
      bestHorizon = trialHorizon;
    } else {
      break;
    }
  }

  const active = capped.slice(0, activePrefix);
  const rawShares = active.map((c) => Math.max(0, c.rate * (bestHorizon - c.fixedDelay)));
  const rawSum = rawShares.reduce((acc, v) => acc + v, 0) || 1;
  const exactShares = rawShares.map((v) => (v / rawSum) * remainingQuantity);

  // Largest-remainder integer allocation with strict q_k >= 1 floor
  let floors = exactShares.map((ex) => Math.max(1, Math.floor(ex)));
  let floorSum = floors.reduce((acc, v) => acc + v, 0);

  if (floorSum > remainingQuantity) {
    // Extreme skew fallback: give 1 to each active bot, distribute remaining - active.length proportionally
    floors = active.map(() => 1);
    const distributable = remainingQuantity - active.length;
    const subExact = rawShares.map((v) => (v / rawSum) * distributable);
    const subFloors = subExact.map((ex) => Math.floor(ex));
    for (let i = 0; i < active.length; i += 1) floors[i] += subFloors[i];
    floorSum = floors.reduce((acc, v) => acc + v, 0);
    const remOrder = active
      .map((c, idx) => ({ idx, botId: c.botId, frac: subExact[idx] - subFloors[idx] }))
      .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.botId.localeCompare(b.botId)));
    let rem = remainingQuantity - floorSum;
    for (let j = 0; j < remOrder.length && rem > 0; j += 1, rem -= 1) {
      floors[remOrder[j].idx] += 1;
    }
  } else {
    const remOrder = active
      .map((c, idx) => ({ idx, botId: c.botId, frac: exactShares[idx] - Math.floor(exactShares[idx]) }))
      .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.botId.localeCompare(b.botId)));
    let rem = remainingQuantity - floorSum;
    for (let j = 0; j < remOrder.length && rem > 0; j += 1, rem -= 1) {
      floors[remOrder[j].idx] += 1;
    }
  }

  const quotas = active.map((c, idx) => ({
    botId: c.botId,
    workerId: c.workerId,
    quantity: floors[idx],
    partitionId: null,
    regionBounds: null,
    role: c.role
  }));

  // Hard invariant assertion (G-05)
  const finalSum = quotas.reduce((acc, q) => acc + q.quantity, 0);
  if (finalSum !== remainingQuantity || quotas.some((q) => !Number.isSafeInteger(q.quantity) || q.quantity < 1)) {
    throw new DomainError('INTERNAL_ERROR', `Quota conservation invariant violated (${finalSum} !== ${remainingQuantity})`);
  }

  return quotas;
}

/**
 * Partition an axis-aligned 2D/3D exploration box into `m` contiguous disjoint sectors.
 */
function partitionRegion(regionSpec, selectedCandidates) {
  if (!Array.isArray(selectedCandidates) || selectedCandidates.length === 0) return [];
  const dim = regionSpec?.dimension || 'minecraft:overworld';
  const minX = Math.trunc(regionSpec?.minX ?? -64);
  const maxX = Math.trunc(regionSpec?.maxX ?? 64);
  const minZ = Math.trunc(regionSpec?.minZ ?? -64);
  const maxZ = Math.trunc(regionSpec?.maxZ ?? 64);
  const minY = Math.trunc(regionSpec?.minY ?? -64);
  const maxY = Math.trunc(regionSpec?.maxY ?? 320);

  const sorted = [...selectedCandidates].sort((a, b) => String(a.botId).localeCompare(String(b.botId)));
  const m = sorted.length;
  const spanX = maxX - minX + 1;
  const spanZ = maxZ - minZ + 1;
  const splitAlongX = spanX >= spanZ;
  const totalSpan = splitAlongX ? spanX : spanZ;

  let cursor = splitAlongX ? minX : minZ;
  return sorted.map((c, idx) => {
    const remainingSlices = m - idx;
    const remainingCells = (splitAlongX ? maxX : maxZ) - cursor + 1;
    const width = idx === m - 1 ? remainingCells : Math.max(1, Math.floor(remainingCells / remainingSlices));
    const sliceStart = cursor;
    const sliceEnd = Math.min(splitAlongX ? maxX : maxZ, sliceStart + width - 1);
    cursor = sliceEnd + 1;

    return {
      botId: String(c.botId),
      workerId: String(c.workerId || 'unknown'),
      quantity: null,
      partitionId: `sector-${idx + 1}-of-${m}`,
      regionBounds: splitAlongX
        ? { dimension: dim, minX: sliceStart, maxX: sliceEnd, minY, maxY, minZ, maxZ }
        : { dimension: dim, minX, maxX, minY, maxY, minZ: sliceStart, maxZ: sliceEnd },
      role: 'explorer',
      totalSpan
    };
  });
}

module.exports = {
  splitQuota,
  partitionRegion
};
