/**
 * Antenna patterns and sector geometry.
 *
 * Antenna configuration is the cheapest lever in a real network: changing a
 * tilt is a software command, changing a site is a year of acquisition and
 * civil works. So a planning tool spends most of its time here, and so does
 * this simulator -- tilt and azimuth should be the controls that visibly move
 * the heatmap.
 *
 * The pattern model is the 3GPP TR 38.901 Table 7.3-1 element: a parabolic
 * main lobe in each plane with a flat side-lobe floor. It is an idealisation.
 * Real antennas ship measured patterns as .msi or .pafx files with nulls,
 * asymmetry and back-lobe structure that a parabola does not capture. The
 * loader interface below takes measured patterns for that reason; the
 * analytic model is the fallback, not the goal.
 */

import { DEG } from '../core/constants';
import { angleDiff } from '../core/math';

/** 3GPP reference half-power beamwidth in both planes, degrees. */
export const HPBW_3GPP = 65;

/** 3GPP front-to-back and side-lobe attenuation floor, dB. */
export const SLA_3GPP = 30;

export interface PatternModel {
  /** Boresight gain, dBi. */
  maxGainDbi: number;
  /** Horizontal half-power beamwidth, degrees. */
  hpbwAzimuthDeg: number;
  /** Vertical half-power beamwidth, degrees. */
  hpbwElevationDeg: number;
  /** Side-lobe and front-to-back floor, dB below boresight. */
  floorDb: number;
}

/** A typical 3-sector macro panel: 65 degrees in azimuth, 18 dBi. */
export const MACRO_PANEL: PatternModel = {
  maxGainDbi: 18,
  hpbwAzimuthDeg: 65,
  hpbwElevationDeg: 7,
  floorDb: 30,
};

/** A small-cell omni: wide in azimuth, low gain. */
export const SMALL_CELL_OMNI: PatternModel = {
  maxGainDbi: 6,
  hpbwAzimuthDeg: 360,
  hpbwElevationDeg: 30,
  floorDb: 10,
};

/** A satellite user terminal: narrow, high gain, Ka-band flat panel. */
export const VSAT_KA: PatternModel = {
  maxGainDbi: 39,
  hpbwAzimuthDeg: 2.5,
  hpbwElevationDeg: 2.5,
  floorDb: 35,
};

/**
 * Relative gain in the azimuth plane, dB below boresight.
 *
 * 12 * (phi / hpbw)^2 is the parabolic approximation: it passes through
 * exactly -3 dB at half the beamwidth, which is what makes the coefficient 12
 * rather than something rounder.
 */
export function azimuthPattern(offsetDeg: number, hpbwDeg: number, floorDb: number): number {
  if (hpbwDeg >= 360) return 0;
  const phi = angleDiff(offsetDeg, 0);
  return -Math.min(floorDb, 12 * (phi / hpbwDeg) ** 2);
}

/** Relative gain in the elevation plane, dB below boresight. */
export function elevationPattern(offsetDeg: number, hpbwDeg: number, floorDb: number): number {
  return -Math.min(floorDb, 12 * (offsetDeg / hpbwDeg) ** 2);
}

export interface SectorOrientation {
  /** Boresight azimuth, degrees clockwise from true north. */
  azimuthDeg: number;
  /**
   * Total downtilt, degrees. Positive points below the horizon.
   *
   * Mechanical and electrical tilt are summed here. They are not actually
   * equivalent -- mechanical tilt rotates the whole pattern, so it squints the
   * azimuth beamwidth off-boresight, while electrical tilt steers the vertical
   * phase taper and keeps the horizontal pattern intact. The distinction
   * matters when tilts exceed about 10 degrees.
   */
  downtiltDeg: number;
}

/**
 * Gain in a given direction, dBi.
 *
 * The two planes are combined additively in dB and then clipped at the floor,
 * which is the 38.901 convention. Adding them is not physically exact for an
 * arbitrary direction off both axes, but it is what the standard specifies
 * and what every system-level simulation uses, so matching it keeps results
 * comparable with published work.
 */
export function sectorGain(
  pattern: PatternModel,
  orientation: SectorOrientation,
  /** Bearing from the antenna to the target, degrees from north. */
  bearingDeg: number,
  /** Elevation from the antenna to the target, degrees above horizontal. */
  elevationDeg: number,
): number {
  const azOffset = angleDiff(bearingDeg, orientation.azimuthDeg);
  const elOffset = elevationDeg + orientation.downtiltDeg;

  const aH = azimuthPattern(azOffset, pattern.hpbwAzimuthDeg, pattern.floorDb);
  const aV = elevationPattern(elOffset, pattern.hpbwElevationDeg, pattern.floorDb);

  const relative = -Math.min(pattern.floorDb, -(aH + aV));
  return pattern.maxGainDbi + relative;
}

/**
 * Lay out N sectors evenly around a site.
 *
 * Three sectors at 0/120/240 is the universal macro configuration; six-sector
 * sites appear in high-capacity urban cores. The first sector points at
 * startAzimuthDeg, which in practice is chosen to aim down the dominant
 * traffic corridor rather than at true north.
 */
export function sectorAzimuths(count: number, startAzimuthDeg = 0): number[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [startAzimuthDeg];
  return Array.from({ length: n }, (_, i) => (startAzimuthDeg + (360 * i) / n) % 360);
}

/**
 * Downtilt that puts the main-lobe edge at a target cell range.
 *
 * The standard planning heuristic: aim the lower half-power point at the cell
 * edge, so tilt = atan(h / r) + hpbw/2. Under-tilting throws energy past the
 * cell edge and creates interference for neighbours; over-tilting leaves a
 * coverage hole just outside the site. Both are visible failure modes in the
 * heatmap, which is the point of exposing it.
 */
export function recommendedDowntilt(
  antennaHeightM: number,
  cellRadiusM: number,
  hpbwElevationDeg: number,
): number {
  if (cellRadiusM <= 0) return 0;
  const geometric = Math.atan(antennaHeightM / cellRadiusM) / DEG;
  return geometric + hpbwElevationDeg / 2;
}
