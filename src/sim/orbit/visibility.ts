/**
 * Satellite visibility, Doppler, and footprint geometry.
 *
 * The "satellite position (relative)" half of the parameter set. Absolute
 * position is an orbit problem; relative position is what a ground terminal
 * actually experiences, and it is where the interesting system behaviour
 * lives: elevation sets the air mass and therefore the atmospheric loss,
 * slant range sets the path loss, and range rate sets the Doppler the modem
 * has to track.
 */

import { DEG, EARTH_MEAN_RADIUS, EARTH_ROTATION_RATE, RAD, C_LIGHT } from '../core/constants';
import type { Ecef, Geodetic, LookAngles } from '../core/types';
import { ecefToGeodetic, geodeticToEcef, enuBasis } from '../geo/wgs84';
import { eciToEcef, propagate, type OrbitalElements, type StateVector } from './elements';

export interface SatelliteObservation extends LookAngles {
  /** Satellite position in the Earth-fixed frame, metres. */
  positionEcef: Ecef;
  /** Sub-satellite point and altitude. */
  subSatellite: Geodetic;
  /** Rate of change of slant range, m/s. Positive means receding. */
  rangeRateMs: number;
  /** True when the satellite is above the station's elevation mask. */
  visible: boolean;
}

/** Velocity of the satellite in the Earth-fixed frame, m/s. */
export function ecefVelocity(state: StateVector, timeMs: number): Ecef {
  const rotated = eciToEcef(state.velocity, timeMs);
  const positionEcef = eciToEcef(state.position, timeMs);
  // Subtract the frame rotation: v_ecef = R*v_eci - omega x r_ecef.
  return {
    x: rotated.x + EARTH_ROTATION_RATE * positionEcef.y,
    y: rotated.y - EARTH_ROTATION_RATE * positionEcef.x,
    z: rotated.z,
  };
}

/**
 * Observe a satellite from a ground station at a given time.
 *
 * The elevation mask defaults to 10 degrees, which is a realistic operational
 * minimum rather than the geometric horizon: below it the air mass climbs
 * steeply, multipath off the local ground becomes significant, and most
 * terminals will not track. Setting it to 0 gives pure geometry, which is
 * what a coverage-area calculation wants, and a very different answer from
 * what a link-availability calculation wants.
 */
export function observe(
  elements: OrbitalElements,
  station: Geodetic,
  timeMs: number,
  elevationMaskDeg = 10,
): SatelliteObservation {
  const state = propagate(elements, timeMs);
  const positionEcef = eciToEcef(state.position, timeMs);
  const velocityEcef = ecefVelocity(state, timeMs);

  const stationEcef = geodeticToEcef(station);
  const dx = positionEcef.x - stationEcef.x;
  const dy = positionEcef.y - stationEcef.y;
  const dz = positionEcef.z - stationEcef.z;
  const rangeM = Math.hypot(dx, dy, dz);

  const { east, north, up } = enuBasis(station.latDeg, station.lonDeg);
  const e = dx * east.x + dy * east.y + dz * east.z;
  const n = dx * north.x + dy * north.y + dz * north.z;
  const u = dx * up.x + dy * up.y + dz * up.z;

  const horizontal = Math.hypot(e, n);
  const elevationDeg = rangeM === 0 ? 90 : Math.atan2(u, horizontal) * RAD;
  const azimuthDeg = (Math.atan2(e, n) * RAD + 360) % 360;

  // Range rate is the projection of relative velocity onto the line of sight.
  const rangeRateMs =
    rangeM === 0
      ? 0
      : (dx * velocityEcef.x + dy * velocityEcef.y + dz * velocityEcef.z) / rangeM;

  return {
    azimuthDeg,
    elevationDeg,
    rangeM,
    positionEcef,
    subSatellite: ecefToGeodetic(positionEcef),
    rangeRateMs,
    visible: elevationDeg >= elevationMaskDeg,
  };
}

/**
 * Doppler shift for a link, Hz.
 *
 * f_shift = -f_carrier * rangeRate / c. Negative range rate (approaching)
 * raises the frequency.
 *
 * The magnitude is the thing worth internalising about LEO: a 550 km
 * satellite at Ku band produces around 700 kHz of shift and sweeps through
 * it in minutes, which is why LEO terminals need fast frequency tracking that
 * a GEO terminal can do without. The same number for GEO is essentially zero,
 * and that difference drives entirely different modem designs.
 */
export function dopplerShiftHz(carrierFreqHz: number, rangeRateMs: number): number {
  return (-carrierFreqHz * rangeRateMs) / C_LIGHT;
}

/**
 * Half-angle of the ground footprint visible above a minimum elevation, degrees.
 *
 * lambda = acos((Re / (Re + h)) * cos(eps)) - eps
 *
 * Returns the Earth-central angle, so the footprint radius on the surface is
 * Re * lambda in radians. The elevation mask shrinks it hard: a 550 km
 * satellite covers a 2 400 km radius down to the geometric horizon but only
 * about 580 km above 40 degrees, which is why LEO broadband needs thousands
 * of satellites rather than hundreds.
 */
export function footprintCentralAngle(altitudeM: number, minElevationDeg = 10): number {
  const eps = minElevationDeg * DEG;
  const ratio = EARTH_MEAN_RADIUS / (EARTH_MEAN_RADIUS + altitudeM);
  const inner = ratio * Math.cos(eps);
  if (inner >= 1) return 0;
  return (Math.acos(inner) - eps) * RAD;
}

/** Radius of the ground footprint, metres. */
export function footprintRadius(altitudeM: number, minElevationDeg = 10): number {
  return EARTH_MEAN_RADIUS * footprintCentralAngle(altitudeM, minElevationDeg) * DEG;
}

/**
 * Slant range to a satellite at a given elevation, metres.
 *
 * Closed form from the law of cosines on the Earth-satellite-station
 * triangle. Useful for sizing a link budget before any orbit is propagated:
 * the worst case is always the minimum elevation, where the range is longest
 * and the atmospheric path is longest too.
 */
export function slantRangeAtElevation(altitudeM: number, elevationDeg: number): number {
  const re = EARTH_MEAN_RADIUS;
  const rs = re + altitudeM;
  const eps = elevationDeg * DEG;
  return Math.sqrt(rs * rs - (re * Math.cos(eps)) ** 2) - re * Math.sin(eps);
}

export interface Pass {
  /** Rise time, Unix ms. */
  startMs: number;
  /** Set time, Unix ms. */
  endMs: number;
  /** Time of maximum elevation, Unix ms. */
  peakMs: number;
  /** Maximum elevation reached, degrees. */
  peakElevationDeg: number;
  /** Minimum slant range during the pass, metres. */
  minRangeM: number;
}

/**
 * Find satellite passes over a station within a time window.
 *
 * Coarse scan then bisection on the horizon crossings. Step size is the
 * accuracy/cost knob: it must be well under the pass duration or passes get
 * missed entirely, and LEO passes last only eight to twelve minutes, so the
 * 30 s default is already near the limit for a 550 km orbit.
 */
export function findPasses(
  elements: OrbitalElements,
  station: Geodetic,
  fromMs: number,
  toMs: number,
  elevationMaskDeg = 10,
  stepMs = 30_000,
): Pass[] {
  const passes: Pass[] = [];
  const elevationAt = (t: number): number =>
    observe(elements, station, t, elevationMaskDeg).elevationDeg;

  const refine = (lowMs: number, highMs: number): number => {
    let lo = lowMs;
    let hi = highMs;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (elevationAt(mid) < elevationMaskDeg) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  let previous = elevationAt(fromMs);
  let riseMs: number | null = previous >= elevationMaskDeg ? fromMs : null;

  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    const current = elevationAt(t);
    const wasUp = previous >= elevationMaskDeg;
    const isUp = current >= elevationMaskDeg;

    if (!wasUp && isUp) {
      riseMs = refine(t - stepMs, t);
    } else if (wasUp && !isUp && riseMs !== null) {
      const setMs = refine(t, t - stepMs);
      passes.push(summarisePass(elements, station, riseMs, setMs, elevationMaskDeg));
      riseMs = null;
    }

    previous = current;
  }

  if (riseMs !== null) {
    passes.push(summarisePass(elements, station, riseMs, toMs, elevationMaskDeg));
  }

  return passes;
}

function summarisePass(
  elements: OrbitalElements,
  station: Geodetic,
  startMs: number,
  endMs: number,
  elevationMaskDeg: number,
): Pass {
  const samples = 60;
  let peakMs = startMs;
  let peakElevationDeg = -90;
  let minRangeM = Number.POSITIVE_INFINITY;

  for (let i = 0; i <= samples; i++) {
    const t = startMs + ((endMs - startMs) * i) / samples;
    const obs = observe(elements, station, t, elevationMaskDeg);
    if (obs.elevationDeg > peakElevationDeg) {
      peakElevationDeg = obs.elevationDeg;
      peakMs = t;
    }
    if (obs.rangeM < minRangeM) minRangeM = obs.rangeM;
  }

  return { startMs, endMs, peakMs, peakElevationDeg, minRangeM };
}

/**
 * Pick the satellite a terminal should be using.
 *
 * Highest elevation wins, which is the standard heuristic: it minimises both
 * slant range and atmospheric path at once. Real constellations also weigh
 * beam capacity, interference toward the geostationary arc, and hysteresis to
 * avoid thrashing between two satellites at similar elevation -- the last of
 * which is why a naive highest-elevation rule produces unrealistically
 * frequent handovers in a simulation.
 */
export function bestSatellite(
  constellation: readonly OrbitalElements[],
  station: Geodetic,
  timeMs: number,
  elevationMaskDeg = 10,
): { elements: OrbitalElements; observation: SatelliteObservation } | null {
  let best: { elements: OrbitalElements; observation: SatelliteObservation } | null = null;

  for (const elements of constellation) {
    const observation = observe(elements, station, timeMs, elevationMaskDeg);
    if (!observation.visible) continue;
    if (!best || observation.elevationDeg > best.observation.elevationDeg) {
      best = { elements, observation };
    }
  }

  return best;
}
