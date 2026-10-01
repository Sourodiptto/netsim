/**
 * Terrain diffraction.
 *
 * Three constructions, because no single one is right everywhere and operator
 * tools let you pick:
 *
 *   Bullington   -- collapses the whole profile into one equivalent edge at
 *                   the intersection of the two horizon rays. Cheap, stable,
 *                   and the basis of the ITU-R P.452 interference model. Can
 *                   under-predict when several ridges each contribute.
 *   Epstein-Peterson -- sums knife-edge losses over successive edges, each
 *                   seen from its neighbours. Better for a few distinct
 *                   ridges; degrades when edges are close together.
 *   Deygout      -- finds the principal edge, then recurses into the two
 *                   sub-paths. The usual default in cell planning. Known to
 *                   over-predict for multiple comparable edges, which is why
 *                   the empirical correction below exists.
 *
 * All three are knife-edge models: they treat a ridge as infinitely thin.
 * Real terrain is rounded, which costs a few more decibels, and real clutter
 * sits on top of it. That gap is absorbed by the clutter corrections rather
 * than pretended away here.
 */

import { diffractionParameter, knifeEdgeLoss } from './fspl';
import type { TerrainProfile } from './profile';

export interface DiffractionResult {
  /** Diffraction loss, dB. Zero means an unobstructed path. */
  lossDb: number;
  /** True when the direct ray clears every profile point. */
  lineOfSight: boolean;
  /** Diffraction parameter of the dominant edge. */
  dominantNu: number;
  /** Distance of the dominant edge from the transmitter, metres. */
  dominantDistanceM: number;
  /** Which construction produced the number. */
  method: 'bullington' | 'epstein-peterson' | 'deygout';
}

/** Height of the straight tx-rx line above datum at a distance along the path. */
function lineHeightAt(d1M: number, totalM: number, txAltM: number, rxAltM: number): number {
  return txAltM + ((rxAltM - txAltM) * d1M) / totalM;
}

/** Find the profile index with the largest diffraction parameter over a sub-path. */
function dominantEdge(
  profile: TerrainProfile,
  startIdx: number,
  endIdx: number,
  startAltM: number,
  endAltM: number,
  freqMhz: number,
): { index: number; nu: number } {
  const dStart = profile.distancesM[startIdx]!;
  const dEnd = profile.distancesM[endIdx]!;
  const span = dEnd - dStart;

  let bestIndex = -1;
  let bestNu = Number.NEGATIVE_INFINITY;

  for (let i = startIdx + 1; i < endIdx; i++) {
    const d1 = profile.distancesM[i]! - dStart;
    const d2 = dEnd - profile.distancesM[i]!;
    if (d1 <= 0 || d2 <= 0) continue;

    const line = lineHeightAt(d1, span, startAltM, endAltM);
    const h = profile.effectiveM[i]! - line;
    const nu = diffractionParameter(h, d1, d2, freqMhz);
    if (nu > bestNu) {
      bestNu = nu;
      bestIndex = i;
    }
  }

  return { index: bestIndex, nu: bestNu };
}

/**
 * Bullington diffraction with the ITU-R P.452 correction.
 *
 * Construct the steepest ray from each terminal to any profile point. If the
 * transmitter's steepest ray is shallower than the direct tx-rx line, the
 * path is line-of-sight and the loss comes from whichever point intrudes
 * furthest into the Fresnel zone. Otherwise the two steepest rays cross at
 * the "Bullington point", and that virtual edge carries the whole loss.
 *
 * The trailing (1 - exp(-L/6)) * (10 + 0.02 d) term is P.452's empirical
 * correction: it accounts for the fact that collapsing real terrain to one
 * edge systematically under-predicts, and it grows with path length.
 */
export function bullingtonDiffraction(
  profile: TerrainProfile,
  txAltM: number,
  rxAltM: number,
  freqMhz: number,
): DiffractionResult {
  const n = profile.distancesM.length;
  const dM = profile.distanceM;
  const dKm = dM / 1000;
  const lambda = 299.792458 / freqMhz;

  if (n < 3 || dM <= 0) {
    return {
      lossDb: 0,
      lineOfSight: true,
      dominantNu: Number.NEGATIVE_INFINITY,
      dominantDistanceM: 0,
      method: 'bullington',
    };
  }

  // Steepest slope seen from the transmitter, m/m.
  let sTim = Number.NEGATIVE_INFINITY;
  let sTimIdx = 1;
  for (let i = 1; i < n - 1; i++) {
    const d1 = profile.distancesM[i]!;
    if (d1 <= 0) continue;
    const slope = (profile.effectiveM[i]! - txAltM) / d1;
    if (slope > sTim) {
      sTim = slope;
      sTimIdx = i;
    }
  }

  const sTr = (rxAltM - txAltM) / dM;

  let nuDominant: number;
  let dominantDistanceM: number;
  let lineOfSight: boolean;

  if (sTim < sTr) {
    // Line of sight: the loss is set by the deepest Fresnel intrusion.
    lineOfSight = true;
    let bestNu = Number.NEGATIVE_INFINITY;
    let bestD = 0;
    for (let i = 1; i < n - 1; i++) {
      const d1 = profile.distancesM[i]!;
      const d2 = dM - d1;
      if (d1 <= 0 || d2 <= 0) continue;
      const h = profile.effectiveM[i]! - lineHeightAt(d1, dM, txAltM, rxAltM);
      const nu = h * Math.sqrt((2 * dM) / (lambda * d1 * d2));
      if (nu > bestNu) {
        bestNu = nu;
        bestD = d1;
      }
    }
    nuDominant = bestNu;
    dominantDistanceM = bestD;
  } else {
    // Transhorizon: build the Bullington point from both steepest rays.
    lineOfSight = false;
    let sRim = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < n - 1; i++) {
      const d2 = dM - profile.distancesM[i]!;
      if (d2 <= 0) continue;
      const slope = (profile.effectiveM[i]! - rxAltM) / d2;
      if (slope > sRim) sRim = slope;
    }

    const dBp = (rxAltM - txAltM + sRim * dM) / (sTim + sRim);
    const dBpClamped = Math.min(dM - 1, Math.max(1, dBp));
    const edgeAlt = txAltM + sTim * dBpClamped;
    const h = edgeAlt - lineHeightAt(dBpClamped, dM, txAltM, rxAltM);
    nuDominant = h * Math.sqrt((2 * dM) / (lambda * dBpClamped * (dM - dBpClamped)));
    dominantDistanceM = dBpClamped;
    void sTimIdx;
  }

  const luc = knifeEdgeLoss(nuDominant);
  const lossDb = luc > 0 ? luc + (1 - Math.exp(-luc / 6)) * (10 + 0.02 * dKm) : 0;

  return { lossDb, lineOfSight, dominantNu: nuDominant, dominantDistanceM, method: 'bullington' };
}

/**
 * Deygout multiple knife-edge diffraction.
 *
 * Recursive by construction: solve the principal edge, then treat the
 * sub-paths from each terminal to the top of that edge as independent
 * problems. Depth is capped at 3 edges, which is what cell-planning tools
 * use -- deeper recursion compounds the method's known tendency to
 * over-predict rather than adding accuracy.
 *
 * Set causebrook to true to apply the Causebrook damping, which scales the
 * secondary edges down as the principal edge loss grows. Operator tools
 * expose this as a separate model choice ("Deygout" vs "Deygout-Causebrook")
 * because the two disagree by several decibels over rolling terrain, and
 * which one matches measurement is a calibration question, not a physics one.
 */
export function deygoutDiffraction(
  profile: TerrainProfile,
  txAltM: number,
  rxAltM: number,
  freqMhz: number,
  options: { maxEdges?: number; causebrook?: boolean } = {},
): DiffractionResult {
  const maxEdges = options.maxEdges ?? 3;
  const causebrook = options.causebrook ?? false;
  const n = profile.distancesM.length;

  if (n < 3 || profile.distanceM <= 0) {
    return {
      lossDb: 0,
      lineOfSight: true,
      dominantNu: Number.NEGATIVE_INFINITY,
      dominantDistanceM: 0,
      method: 'deygout',
    };
  }

  const principal = dominantEdge(profile, 0, n - 1, txAltM, rxAltM, freqMhz);

  if (principal.index < 0 || principal.nu <= -0.78) {
    return {
      lossDb: 0,
      lineOfSight: true,
      dominantNu: principal.nu,
      dominantDistanceM: 0,
      method: 'deygout',
    };
  }

  const principalLoss = knifeEdgeLoss(principal.nu);
  const principalAlt = profile.effectiveM[principal.index]!;

  let secondary = 0;
  if (maxEdges > 1) {
    const left = dominantEdge(profile, 0, principal.index, txAltM, principalAlt, freqMhz);
    if (left.index >= 0 && left.nu > -0.78) secondary += knifeEdgeLoss(left.nu);

    const right = dominantEdge(profile, principal.index, n - 1, principalAlt, rxAltM, freqMhz);
    if (right.index >= 0 && right.nu > -0.78) secondary += knifeEdgeLoss(right.nu);
  }

  // Causebrook damping: the principal edge already shadows the sub-paths, so
  // their contributions should not be counted at full weight.
  const weight = causebrook ? Math.exp(-principalLoss / 20) : 1;

  return {
    lossDb: principalLoss + weight * secondary,
    lineOfSight: principal.nu <= 0,
    dominantNu: principal.nu,
    dominantDistanceM: profile.distancesM[principal.index]!,
    method: 'deygout',
  };
}

/**
 * Epstein-Peterson multiple knife-edge diffraction.
 *
 * Walk the profile finding successive horizon edges, then sum the knife-edge
 * loss of each as seen from its two neighbours. Physically the most intuitive
 * of the three and the most accurate for well-separated ridges; it
 * under-predicts when edges crowd together, because it ignores the
 * correlation between adjacent diffractions.
 */
export function epsteinPetersonDiffraction(
  profile: TerrainProfile,
  txAltM: number,
  rxAltM: number,
  freqMhz: number,
  maxEdges = 4,
): DiffractionResult {
  const n = profile.distancesM.length;
  const dM = profile.distanceM;

  if (n < 3 || dM <= 0) {
    return {
      lossDb: 0,
      lineOfSight: true,
      dominantNu: Number.NEGATIVE_INFINITY,
      dominantDistanceM: 0,
      method: 'epstein-peterson',
    };
  }

  // Successive horizon edges: from each vantage point, the steepest-slope point.
  const edges: number[] = [];
  let fromIdx = 0;
  let fromAlt = txAltM;

  while (edges.length < maxEdges) {
    let bestSlope = Number.NEGATIVE_INFINITY;
    let bestIdx = -1;
    for (let i = fromIdx + 1; i < n - 1; i++) {
      const dx = profile.distancesM[i]! - profile.distancesM[fromIdx]!;
      if (dx <= 0) continue;
      const slope = (profile.effectiveM[i]! - fromAlt) / dx;
      if (slope > bestSlope) {
        bestSlope = slope;
        bestIdx = i;
      }
    }
    const directSlope = (rxAltM - fromAlt) / (dM - profile.distancesM[fromIdx]!);
    if (bestIdx < 0 || bestSlope <= directSlope) break;
    edges.push(bestIdx);
    fromIdx = bestIdx;
    fromAlt = profile.effectiveM[bestIdx]!;
  }

  if (edges.length === 0) {
    return {
      lossDb: 0,
      lineOfSight: true,
      dominantNu: Number.NEGATIVE_INFINITY,
      dominantDistanceM: 0,
      method: 'epstein-peterson',
    };
  }

  let lossDb = 0;
  let dominantNu = Number.NEGATIVE_INFINITY;
  let dominantDistanceM = 0;

  for (let e = 0; e < edges.length; e++) {
    const idx = edges[e]!;
    const prevIdx = e === 0 ? 0 : edges[e - 1]!;
    const nextIdx = e === edges.length - 1 ? n - 1 : edges[e + 1]!;

    const prevAlt = e === 0 ? txAltM : profile.effectiveM[prevIdx]!;
    const nextAlt = e === edges.length - 1 ? rxAltM : profile.effectiveM[nextIdx]!;

    const d1 = profile.distancesM[idx]! - profile.distancesM[prevIdx]!;
    const d2 = profile.distancesM[nextIdx]! - profile.distancesM[idx]!;
    if (d1 <= 0 || d2 <= 0) continue;

    const line = prevAlt + ((nextAlt - prevAlt) * d1) / (d1 + d2);
    const h = profile.effectiveM[idx]! - line;
    const nu = diffractionParameter(h, d1, d2, freqMhz);
    lossDb += knifeEdgeLoss(nu);

    if (nu > dominantNu) {
      dominantNu = nu;
      dominantDistanceM = profile.distancesM[idx]!;
    }
  }

  return { lossDb, lineOfSight: false, dominantNu, dominantDistanceM, method: 'epstein-peterson' };
}

export type DiffractionMethod = 'bullington' | 'epstein-peterson' | 'deygout' | 'deygout-causebrook';

/** Dispatch to a named diffraction construction. */
export function diffractionLoss(
  method: DiffractionMethod,
  profile: TerrainProfile,
  txAltM: number,
  rxAltM: number,
  freqMhz: number,
): DiffractionResult {
  switch (method) {
    case 'bullington':
      return bullingtonDiffraction(profile, txAltM, rxAltM, freqMhz);
    case 'epstein-peterson':
      return epsteinPetersonDiffraction(profile, txAltM, rxAltM, freqMhz);
    case 'deygout':
      return deygoutDiffraction(profile, txAltM, rxAltM, freqMhz, { causebrook: false });
    case 'deygout-causebrook':
      return deygoutDiffraction(profile, txAltM, rxAltM, freqMhz, { causebrook: true });
  }
}
