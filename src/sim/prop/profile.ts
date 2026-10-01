/**
 * Terrain path profiles.
 *
 * A diffraction model does not take two endpoints -- it takes the terrain
 * between them. This module turns a pair of geodetic positions plus a terrain
 * sampler into the equally-spaced height profile the diffraction code
 * consumes, and applies the Earth-curvature correction that lets the rest of
 * the maths treat rays as straight lines.
 *
 * The curvature correction is where the atmosphere re-enters: the bulge is
 * computed against the effective Earth radius k*a, so the same terrain yields
 * different obstruction heights under different refractivity gradients. A
 * ridge that just clears the path on a standard day blocks it when the
 * gradient flattens.
 */

import { greatCirclePath, vincentyInverse } from '../geo/geodesic';
import { effectiveEarthRadius, STANDARD_GRADIENT_N_PER_KM } from '../atmos/refractivity';
import type { Geodetic } from '../core/types';

/** Returns ground elevation above mean sea level in metres at a lat/lon. */
export type TerrainSampler = (latDeg: number, lonDeg: number) => number;

/** A flat-world sampler, for tests and for ocean paths. */
export const flatTerrain: TerrainSampler = () => 0;

export interface TerrainProfile {
  /** Total path length, metres. */
  distanceM: number;
  /** Horizontal distance of each sample from the transmitter, metres. */
  distancesM: Float64Array;
  /** Ground elevation above mean sea level at each sample, metres. */
  groundM: Float64Array;
  /**
   * Ground elevation plus Earth bulge at each sample, metres. This is the
   * profile a straight-ray diffraction model should use.
   */
  effectiveM: Float64Array;
  /** The refractivity gradient the bulge was computed with, N-units/km. */
  gradientNPerKm: number;
  /** Lat/lon of each sample, for re-sampling clutter or rain along the path. */
  points: { latDeg: number; lonDeg: number }[];
}

/**
 * Build a terrain profile between two points.
 *
 * Sample count is a direct accuracy/cost trade. A rule of thumb from
 * operator tools: sample at or below the terrain raster's own resolution, so
 * 30 m SRTM over a 20 km path wants about 650 points. For the interactive
 * heatmap the engine drops this to 16 to 32 taps, which is coarse but
 * captures the dominant ridge -- and the dominant ridge is what Deygout and
 * Bullington both key off anyway.
 */
export function buildProfile(
  from: Geodetic,
  to: Geodetic,
  terrain: TerrainSampler,
  sampleCount = 128,
  gradientNPerKm = STANDARD_GRADIENT_N_PER_KM,
): TerrainProfile {
  const n = Math.max(3, Math.floor(sampleCount));
  const distanceM = vincentyInverse(from.latDeg, from.lonDeg, to.latDeg, to.lonDeg).distanceM;
  const path = greatCirclePath(from, to, n);
  const aeM = effectiveEarthRadius(gradientNPerKm);

  const distancesM = new Float64Array(n);
  const groundM = new Float64Array(n);
  const effectiveM = new Float64Array(n);
  const points: { latDeg: number; lonDeg: number }[] = [];

  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    const d1 = p.fraction * distanceM;
    const d2 = distanceM - d1;
    const ground = terrain(p.latDeg, p.lonDeg);

    distancesM[i] = d1;
    groundM[i] = ground;
    effectiveM[i] = ground + (d1 * d2) / (2 * aeM);
    points.push({ latDeg: p.latDeg, lonDeg: p.lonDeg });
  }

  return { distanceM, distancesM, groundM, effectiveM, gradientNPerKm, points };
}

/**
 * Effective antenna height above the dominant terrain, metres.
 *
 * Empirical macro-cell models all take a base-station height, but they mean
 * height above the surrounding terrain, not above sea level or above the mast
 * foundation. Feeding them the wrong one is a classic error worth tens of
 * decibels over hilly ground. This uses the mean terrain over the middle
 * portion of the path, which is the convention the Standard Propagation Model
 * and COST-231 calibrations were fitted against.
 *
 * Floored at 1 m because the empirical models take log(h_b) and would
 * otherwise diverge for a mast sitting below the local mean.
 */
export function effectiveAntennaHeight(
  profile: TerrainProfile,
  antennaAltM: number,
  windowStart = 0.1,
  windowEnd = 0.9,
): number {
  const n = profile.groundM.length;
  const lo = Math.max(0, Math.floor(n * windowStart));
  const hi = Math.min(n - 1, Math.ceil(n * windowEnd));
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i++) {
    sum += profile.groundM[i]!;
    count++;
  }
  const meanTerrain = count > 0 ? sum / count : 0;
  return Math.max(1, antennaAltM - meanTerrain);
}

/**
 * Fraction of the first Fresnel zone that stays clear along the path.
 *
 * 1.0 means fully clear, 0.6 is the microwave design threshold, 0 means the
 * line of sight is grazing an obstruction and below 0 it is blocked. Reported
 * alongside diffraction loss because it is the number a planner reads: it
 * says how much headroom a link has before terrain starts to matter, which a
 * loss figure of 0 dB does not.
 */
export function fresnelClearance(
  profile: TerrainProfile,
  txAltM: number,
  rxAltM: number,
  freqMhz: number,
): number {
  const n = profile.distancesM.length;
  const d = profile.distanceM;
  if (d <= 0) return 1;

  const lambda = 299.792458 / freqMhz; // metres
  let worst = Number.POSITIVE_INFINITY;

  for (let i = 1; i < n - 1; i++) {
    const d1 = profile.distancesM[i]!;
    const d2 = d - d1;
    if (d1 <= 0 || d2 <= 0) continue;

    const lineHeight = txAltM + ((rxAltM - txAltM) * d1) / d;
    const clearanceM = lineHeight - profile.effectiveM[i]!;
    const r1 = Math.sqrt((lambda * d1 * d2) / d);
    if (r1 <= 0) continue;

    const ratio = clearanceM / r1;
    if (ratio < worst) worst = ratio;
  }

  return Number.isFinite(worst) ? worst : 1;
}
