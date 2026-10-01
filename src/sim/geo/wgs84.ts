/**
 * WGS84 geodetic <-> Cartesian conversions and local tangent-plane geometry.
 *
 * The simulator keeps every position in ECEF internally: it makes range, look
 * angles and line-of-sight tests pure vector algebra, and it avoids the
 * latitude-dependent distortion you get from working in lat/lon directly.
 */

import { DEG, RAD, WGS84_A, WGS84_B, WGS84_E2, WGS84_EP2 } from '../core/constants';
import type { Ecef, Enu, Geodetic, LookAngles } from '../core/types';

/** Prime vertical radius of curvature at a given latitude, metres. */
export function primeVerticalRadius(latDeg: number): number {
  const sinLat = Math.sin(latDeg * DEG);
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
}

/** Geodetic (lat, lon, height) to ECEF. */
export function geodeticToEcef(p: Geodetic): Ecef {
  const lat = p.latDeg * DEG;
  const lon = p.lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const r = (n + p.altM) * cosLat;
  return {
    x: r * Math.cos(lon),
    y: r * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + p.altM) * sinLat,
  };
}

/**
 * ECEF to geodetic, using Ferrari's closed-form solution of the quartic as
 * arranged by Zhu. Exact to sub-millimetre everywhere outside the geocentre,
 * with no iteration -- which matters because the heatmap calls this per pixel.
 */
export function ecefToGeodetic(p: Ecef): Geodetic {
  const { x, y, z } = p;
  const lonDeg = Math.atan2(y, x) * RAD;

  const r = Math.hypot(x, y);
  if (r < 1e-9) {
    // On the spin axis: latitude is +/-90 deg, longitude is undefined (report 0).
    const sign = z >= 0 ? 1 : -1;
    return { latDeg: sign * 90, lonDeg: 0, altM: Math.abs(z) - WGS84_B };
  }

  const e2 = WGS84_E2;
  const ep2 = WGS84_EP2;
  const a = WGS84_A;
  const b = WGS84_B;

  const f = 54 * b * b * z * z;
  const g = r * r + (1 - e2) * z * z - e2 * (a * a - b * b);
  const c = (e2 * e2 * f * r * r) / (g * g * g);
  const s = Math.cbrt(1 + c + Math.sqrt(Math.max(0, c * c + 2 * c)));
  const t = (s + 1 / s + 1) ** 2;
  const p0 = f / (3 * t * g * g);
  const q = Math.sqrt(Math.max(0, 1 + 2 * e2 * e2 * p0));
  const r0 =
    -((p0 * e2 * r) / (1 + q)) +
    Math.sqrt(
      Math.max(
        0,
        0.5 * a * a * (1 + 1 / q) -
          (p0 * (1 - e2) * z * z) / (q * (1 + q)) -
          0.5 * p0 * r * r,
      ),
    );
  const u = Math.hypot(r - e2 * r0, z);
  const v = Math.hypot(r - e2 * r0, Math.sqrt(1 - e2) * z);
  const z0 = (b * b * z) / (a * v);

  return {
    latDeg: Math.atan2(z + ep2 * z0, r) * RAD,
    lonDeg,
    altM: u * (1 - (b * b) / (a * v)),
  };
}

/** Unit vectors of the local east-north-up frame at a geodetic point, in ECEF. */
export function enuBasis(latDeg: number, lonDeg: number): { east: Ecef; north: Ecef; up: Ecef } {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const sLon = Math.sin(lon);
  const cLon = Math.cos(lon);
  return {
    east: { x: -sLon, y: cLon, z: 0 },
    north: { x: -sLat * cLon, y: -sLat * sLon, z: cLat },
    up: { x: cLat * cLon, y: cLat * sLon, z: sLat },
  };
}

/** Express a target's ECEF position in the observer's east-north-up frame. */
export function ecefToEnu(observer: Geodetic, target: Ecef): Enu {
  const o = geodeticToEcef(observer);
  const dx = target.x - o.x;
  const dy = target.y - o.y;
  const dz = target.z - o.z;
  const { east, north, up } = enuBasis(observer.latDeg, observer.lonDeg);
  return {
    e: dx * east.x + dy * east.y + dz * east.z,
    n: dx * north.x + dy * north.y + dz * north.z,
    u: dx * up.x + dy * up.y + dz * up.z,
  };
}

/**
 * Topocentric look angles from an observer to a target.
 *
 * Elevation here is geometric -- it ignores atmospheric refraction, which
 * bends a ray upward and makes a target appear higher than it really is. For
 * satellite links below roughly 10 degrees that correction matters; it lives
 * in atmos/refractivity so the geometry here stays exact and unopinionated.
 */
export function lookAngles(observer: Geodetic, target: Ecef): LookAngles {
  const { e, n, u } = ecefToEnu(observer, target);
  const horizontal = Math.hypot(e, n);
  const rangeM = Math.hypot(horizontal, u);
  return {
    azimuthDeg: (Math.atan2(e, n) * RAD + 360) % 360,
    elevationDeg: rangeM === 0 ? 0 : Math.atan2(u, horizontal) * RAD,
    rangeM,
  };
}

/** Straight-line (chord) distance between two geodetic points, metres. */
export function slantRange(a: Geodetic, b: Geodetic): number {
  const pa = geodeticToEcef(a);
  const pb = geodeticToEcef(b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
}

/** Vector dot product in ECEF. */
export function dot(a: Ecef, b: Ecef): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Vector magnitude in ECEF, metres. */
export function norm(a: Ecef): number {
  return Math.hypot(a.x, a.y, a.z);
}
