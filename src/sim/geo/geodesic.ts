/**
 * Distances and paths along the Earth's surface.
 *
 * Two implementations on purpose:
 *   - haversine is the spherical approximation: ~0.3% error, fast enough to
 *     run per heatmap pixel.
 *   - vincentyInverse is the ellipsoidal solution: sub-millimetre, used for
 *     the validation suite and for anything the user reads as a number.
 *
 * Mixing them silently would be a correctness trap, so each is named for what
 * it is and the test suite pins the gap between them.
 */

import { DEG, EARTH_MEAN_RADIUS, RAD, WGS84_A, WGS84_B, WGS84_F } from '../core/constants';
import type { Geodetic } from '../core/types';

/** Great-circle distance on a sphere of mean Earth radius, metres. */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radius = EARTH_MEAN_RADIUS,
): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface GeodesicResult {
  /** Geodesic distance along the ellipsoid surface, metres. */
  distanceM: number;
  /** Forward azimuth at point 1, degrees from north. */
  initialBearingDeg: number;
  /** Forward azimuth at point 2, degrees from north. */
  finalBearingDeg: number;
  /** False when the solver hit its iteration cap and the spherical fallback was used. */
  converged: boolean;
}

/**
 * Vincenty inverse solution on the WGS84 ellipsoid.
 *
 * Converges in a handful of iterations except for near-antipodal pairs, where
 * it is known to stall. We cap the iteration count and fall back to the
 * spherical answer, reporting converged: false, rather than return a silently
 * wrong number.
 */
export function vincentyInverse(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): GeodesicResult {
  const a = WGS84_A;
  const b = WGS84_B;
  const f = WGS84_F;

  const L = (lon2 - lon1) * DEG;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * DEG));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * DEG));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinLambda = 0;
  let cosLambda = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  let converged = false;

  for (let i = 0; i < 200; i++) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) {
      return { distanceM: 0, initialBearingDeg: 0, finalBearingDeg: 0, converged: true };
    }
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    const d = haversine(lat1, lon1, lat2, lon2);
    const bearing = initialBearing(lat1, lon1, lat2, lon2);
    return {
      distanceM: d,
      initialBearingDeg: bearing,
      finalBearingDeg: bearing,
      converged: false,
    };
  }

  const u2 = cos2Alpha * ((a * a - b * b) / (b * b));
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  return {
    distanceM: b * A * (sigma - deltaSigma),
    initialBearingDeg:
      (Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * RAD + 360) % 360,
    finalBearingDeg:
      (Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda) * RAD + 360) % 360,
    converged: true,
  };
}

/** Spherical initial bearing from point 1 to point 2, degrees from north. */
export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dL = (lon2 - lon1) * DEG;
  const y = Math.sin(dL) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** A point sampled along a surface path, with its fractional position on it. */
export interface PathPoint {
  latDeg: number;
  lonDeg: number;
  /** Position along the path, 0 at the start and 1 at the end. */
  fraction: number;
}

/**
 * Sample count points along the great circle between two geodetic points,
 * inclusive of both ends. This builds the terrain profile a diffraction model
 * needs. Spherical interpolation is accurate enough here because the profile
 * is resampled against a terrain raster afterwards, and that raster's own
 * resolution dominates the error budget.
 */
export function greatCirclePath(from: Geodetic, to: Geodetic, count: number): PathPoint[] {
  const n = Math.max(2, Math.floor(count));
  const p1 = from.latDeg * DEG;
  const l1 = from.lonDeg * DEG;
  const p2 = to.latDeg * DEG;
  const l2 = to.lonDeg * DEG;

  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((p2 - p1) / 2) ** 2 +
            Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2,
        ),
      ),
    );

  const out: PathPoint[] = [];
  if (d < 1e-12) {
    for (let i = 0; i < n; i++) {
      out.push({ latDeg: from.latDeg, lonDeg: from.lonDeg, fraction: i / (n - 1) });
    }
    return out;
  }

  const sinD = Math.sin(d);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const A = Math.sin((1 - t) * d) / sinD;
    const B = Math.sin(t * d) / sinD;
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push({
      latDeg: Math.atan2(z, Math.hypot(x, y)) * RAD,
      lonDeg: Math.atan2(y, x) * RAD,
      fraction: t,
    });
  }
  return out;
}

/**
 * Move from a point along a bearing by a surface distance, on the sphere.
 * Used to lay out candidate site grids and hexagonal cell patterns.
 */
export function destination(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceM: number,
  radius = EARTH_MEAN_RADIUS,
): { latDeg: number; lonDeg: number } {
  const d = distanceM / radius;
  const p1 = latDeg * DEG;
  const l1 = lonDeg * DEG;
  const brg = bearingDeg * DEG;
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sinP2)));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * sinP2,
    );
  return { latDeg: p2 * RAD, lonDeg: (((l2 * RAD + 540) % 360) - 180) };
}
