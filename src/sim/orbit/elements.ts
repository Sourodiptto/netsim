/**
 * Orbital elements, TLE parsing, and propagation.
 *
 * Scope statement, because this is the part of the kernel most likely to be
 * mistaken for something it is not: this is a J2-perturbed Keplerian
 * propagator, not SGP4. It takes TLE mean elements and advances them with the
 * secular rates from Earth's oblateness, which captures the two effects that
 * matter for link geometry -- nodal regression and apsidal precession -- but
 * omits atmospheric drag, solar radiation pressure, lunisolar perturbations
 * and the short-period terms SGP4 models.
 *
 * What that costs: for a LEO satellite the position error grows to a few
 * kilometres within a day of the epoch, and tens of kilometres within a week.
 * For elevation angles, slant range and footprint geometry at the resolution
 * a heatmap renders, that is immaterial. For pointing a real antenna or
 * predicting a pass to the second, it is not, and SGP4 is the right answer.
 *
 * The TLE parser is exact, so swapping in a full SGP4 implementation later
 * requires no change above this layer.
 */

import { DEG, EARTH_J2, EARTH_MU, RAD, WGS84_A } from '../core/constants';
import type { Ecef, Eci } from '../core/types';

export interface OrbitalElements {
  /** Satellite name or catalogue designation. */
  name: string;
  /** NORAD catalogue number, if known. */
  catalogNumber?: number;
  /** Epoch as a Unix timestamp in milliseconds. */
  epochMs: number;
  /** Inclination, degrees. */
  inclinationDeg: number;
  /** Right ascension of the ascending node, degrees. */
  raanDeg: number;
  /** Eccentricity, dimensionless. */
  eccentricity: number;
  /** Argument of perigee, degrees. */
  argPerigeeDeg: number;
  /** Mean anomaly at epoch, degrees. */
  meanAnomalyDeg: number;
  /** Mean motion, revolutions per day. */
  meanMotionRevPerDay: number;
  /** First derivative of mean motion, rev/day^2. Drag proxy; unused by this propagator. */
  meanMotionDot?: number;
  /** B* drag term. Carried for a future SGP4 swap; unused here. */
  bstar?: number;
}

/** Semi-major axis from mean motion, metres. */
export function semiMajorAxis(meanMotionRevPerDay: number): number {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400; // rad/s
  return (EARTH_MU / (n * n)) ** (1 / 3);
}

/** Orbital period, seconds. */
export function orbitalPeriod(meanMotionRevPerDay: number): number {
  return 86400 / meanMotionRevPerDay;
}

/**
 * Parse a two-line element set.
 *
 * TLEs are a fixed-column format from the punch-card era, which is why this
 * reads as substring arithmetic. The implied decimal point on eccentricity
 * and the exponent notation on B* are the two fields people get wrong.
 */
export function parseTle(line1: string, line2: string, name = 'UNNAMED'): OrbitalElements {
  const epochYear = Number.parseInt(line1.slice(18, 20), 10);
  const epochDay = Number.parseFloat(line1.slice(20, 32));
  const fullYear = epochYear < 57 ? 2000 + epochYear : 1900 + epochYear;

  // Day 1.0 is 1 January at 00:00 UTC.
  const yearStart = Date.UTC(fullYear, 0, 1);
  const epochMs = yearStart + (epochDay - 1) * 86_400_000;

  const bstarRaw = line1.slice(53, 61).trim();
  const bstar = parseExponentField(bstarRaw);

  return {
    name: name.trim(),
    catalogNumber: Number.parseInt(line1.slice(2, 7), 10),
    epochMs,
    inclinationDeg: Number.parseFloat(line2.slice(8, 16)),
    raanDeg: Number.parseFloat(line2.slice(17, 25)),
    // Eccentricity has an assumed leading decimal point.
    eccentricity: Number.parseFloat(`0.${line2.slice(26, 33).trim()}`),
    argPerigeeDeg: Number.parseFloat(line2.slice(34, 42)),
    meanAnomalyDeg: Number.parseFloat(line2.slice(43, 51)),
    meanMotionRevPerDay: Number.parseFloat(line2.slice(52, 63)),
    meanMotionDot: Number.parseFloat(line1.slice(33, 43)),
    bstar,
  };
}

/** Parse the TLE exponent notation, e.g. " 12345-3" meaning 0.12345e-3. */
function parseExponentField(raw: string): number {
  if (!raw) return 0;
  const sign = raw.startsWith('-') ? -1 : 1;
  const body = raw.replace(/^[+-]/, '');
  const match = body.match(/^(\d+)([+-]\d)$/);
  if (!match) return 0;
  const mantissa = Number.parseFloat(`0.${match[1]}`);
  const exponent = Number.parseInt(match[2]!, 10);
  return sign * mantissa * 10 ** exponent;
}

/** Parse a three-line TLE block (name plus two element lines). */
export function parseTleBlock(block: string): OrbitalElements | null {
  const lines = block
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;

  if (lines.length >= 3 && lines[1]!.startsWith('1 ') && lines[2]!.startsWith('2 ')) {
    return parseTle(lines[1]!, lines[2]!, lines[0]!);
  }
  if (lines[0]!.startsWith('1 ') && lines[1]!.startsWith('2 ')) {
    return parseTle(lines[0]!, lines[1]!);
  }
  return null;
}

/** Parse a full Celestrak-style TLE file into an element list. */
export function parseTleFile(text: string): OrbitalElements[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: OrbitalElements[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.startsWith('1 ') && i + 1 < lines.length && lines[i + 1]!.startsWith('2 ')) {
      out.push(parseTle(lines[i]!, lines[i + 1]!));
      i += 2;
    } else if (
      i + 2 < lines.length &&
      lines[i + 1]!.startsWith('1 ') &&
      lines[i + 2]!.startsWith('2 ')
    ) {
      out.push(parseTle(lines[i + 1]!, lines[i + 2]!, lines[i]!));
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * Solve Kepler's equation M = E - e sin E for the eccentric anomaly.
 *
 * Newton-Raphson, which converges in three or four iterations for the
 * near-circular orbits every communications constellation uses. The initial
 * guess E = M is adequate below e = 0.8.
 */
export function solveKepler(meanAnomalyRad: number, eccentricity: number): number {
  let E = meanAnomalyRad;
  for (let i = 0; i < 30; i++) {
    const f = E - eccentricity * Math.sin(E) - meanAnomalyRad;
    const fPrime = 1 - eccentricity * Math.cos(E);
    const delta = f / fPrime;
    E -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return E;
}

export interface StateVector {
  /** Position in the Earth-centred inertial frame, metres. */
  position: Eci;
  /** Velocity in the Earth-centred inertial frame, m/s. */
  velocity: Eci;
}

/**
 * Propagate elements to a time and return an inertial state vector.
 *
 * The J2 secular rates applied here are the standard first-order ones:
 *
 *   dRAAN/dt = -1.5 n J2 (Re/p)^2 cos i
 *   dargp/dt =  0.75 n J2 (Re/p)^2 (5 cos^2 i - 1)
 *   dM/dt    =  n + 0.75 n J2 (Re/p)^2 sqrt(1-e^2) (3 cos^2 i - 1)
 *
 * The first is why sun-synchronous orbits exist: at about 98 degrees
 * inclination the nodal regression exactly matches Earth's motion around the
 * Sun, so the orbital plane holds a fixed angle to the Sun. The second is why
 * Molniya orbits sit at 63.4 degrees, where 5cos^2(i) - 1 vanishes and the
 * apogee stops drifting.
 */
export function propagate(elements: OrbitalElements, timeMs: number): StateVector {
  const dtSec = (timeMs - elements.epochMs) / 1000;

  const n0 = (elements.meanMotionRevPerDay * 2 * Math.PI) / 86400; // rad/s
  const a = semiMajorAxis(elements.meanMotionRevPerDay);
  const e = elements.eccentricity;
  const i = elements.inclinationDeg * DEG;

  const p = a * (1 - e * e);
  const j2Factor = EARTH_J2 * (WGS84_A / p) ** 2;
  const cosI = Math.cos(i);

  const raanDot = -1.5 * n0 * j2Factor * cosI;
  const argpDot = 0.75 * n0 * j2Factor * (5 * cosI * cosI - 1);
  const mDot = n0 + 0.75 * n0 * j2Factor * Math.sqrt(1 - e * e) * (3 * cosI * cosI - 1);

  const raan = elements.raanDeg * DEG + raanDot * dtSec;
  const argp = elements.argPerigeeDeg * DEG + argpDot * dtSec;
  const M = elements.meanAnomalyDeg * DEG + mDot * dtSec;

  const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);

  // Perifocal coordinates.
  const r = a * (1 - e * cosE);
  const xP = a * (cosE - e);
  const yP = a * Math.sqrt(1 - e * e) * sinE;

  // Perifocal velocity.
  const nCurrent = Math.sqrt(EARTH_MU / (a * a * a));
  const vxP = (-a * nCurrent * sinE) / (1 - e * cosE);
  const vyP = (a * nCurrent * Math.sqrt(1 - e * e) * cosE) / (1 - e * cosE);

  // Rotate perifocal to inertial: Rz(-raan) Rx(-i) Rz(-argp).
  const cosRaan = Math.cos(raan);
  const sinRaan = Math.sin(raan);
  const cosArgp = Math.cos(argp);
  const sinArgp = Math.sin(argp);
  const sinI = Math.sin(i);

  const r11 = cosRaan * cosArgp - sinRaan * sinArgp * cosI;
  const r12 = -cosRaan * sinArgp - sinRaan * cosArgp * cosI;
  const r21 = sinRaan * cosArgp + cosRaan * sinArgp * cosI;
  const r22 = -sinRaan * sinArgp + cosRaan * cosArgp * cosI;
  const r31 = sinArgp * sinI;
  const r32 = cosArgp * sinI;

  void r;

  return {
    position: {
      x: r11 * xP + r12 * yP,
      y: r21 * xP + r22 * yP,
      z: r31 * xP + r32 * yP,
    },
    velocity: {
      x: r11 * vxP + r12 * vyP,
      y: r21 * vxP + r22 * vyP,
      z: r31 * vxP + r32 * vyP,
    },
  };
}

/**
 * Greenwich mean sidereal time, degrees. IAU 1982 series.
 *
 * The bridge between the inertial frame orbits live in and the rotating frame
 * the ground lives in. Getting this wrong by a few seconds of time moves a
 * satellite's ground track by kilometres, which is the classic cause of a
 * satellite tracker that is subtly but consistently off.
 */
export function gmstDeg(timeMs: number): number {
  const jd = timeMs / 86_400_000 + 2_440_587.5;
  const t = (jd - 2_451_545.0) / 36_525;
  const gmst =
    280.46061837 +
    360.98564736629 * (jd - 2_451_545.0) +
    0.000387933 * t * t -
    (t * t * t) / 38_710_000;
  return ((gmst % 360) + 360) % 360;
}

/** Rotate an inertial position into the Earth-fixed frame. */
export function eciToEcef(position: Eci, timeMs: number): Ecef {
  const theta = gmstDeg(timeMs) * DEG;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    x: position.x * cosT + position.y * sinT,
    y: -position.x * sinT + position.y * cosT,
    z: position.z,
  };
}

/** Rotate an Earth-fixed position into the inertial frame. */
export function ecefToEci(position: Ecef, timeMs: number): Eci {
  const theta = gmstDeg(timeMs) * DEG;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  return {
    x: position.x * cosT - position.y * sinT,
    y: position.x * sinT + position.y * cosT,
    z: position.z,
  };
}

/** Build circular-orbit elements directly, for constellation presets. */
export function circularOrbit(params: {
  name: string;
  altitudeKm: number;
  inclinationDeg: number;
  raanDeg: number;
  /** Phase along the orbit at epoch, degrees. */
  phaseDeg: number;
  epochMs: number;
}): OrbitalElements {
  const a = WGS84_A + params.altitudeKm * 1000;
  const n = Math.sqrt(EARTH_MU / (a * a * a)); // rad/s
  return {
    name: params.name,
    epochMs: params.epochMs,
    inclinationDeg: params.inclinationDeg,
    raanDeg: params.raanDeg,
    eccentricity: 0,
    argPerigeeDeg: 0,
    meanAnomalyDeg: params.phaseDeg,
    meanMotionRevPerDay: (n * 86400) / (2 * Math.PI),
  };
}

/** Geostationary elements for a given sub-satellite longitude. */
export function geostationaryOrbit(
  name: string,
  longitudeDeg: number,
  epochMs: number,
): OrbitalElements {
  // At GEO, RAAN plus mean anomaly equals the sidereal angle of the longitude.
  const targetRa = (gmstDeg(epochMs) + longitudeDeg + 360) % 360;
  return {
    name,
    epochMs,
    inclinationDeg: 0,
    raanDeg: 0,
    eccentricity: 0,
    argPerigeeDeg: 0,
    meanAnomalyDeg: targetRa,
    meanMotionRevPerDay: 1.0027379093,
  };
}

/** Radians-to-degrees convenience for callers working with raw element maths. */
export const toDeg = (rad: number): number => rad * RAD;
