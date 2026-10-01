/**
 * Land-use clutter.
 *
 * Terrain tells you where the ridges are. Clutter tells you what is sitting
 * on top of them, and over a city that is worth more decibels than the
 * terrain is. Every operator planning tool carries a clutter raster beside
 * the terrain raster for exactly this reason.
 *
 * Two distinct numbers per class, often confused:
 *
 *   heightM    -- physical height of the clutter layer. Geometric. Feeds
 *                 diffraction over rooftops and the effective antenna height.
 *   lossDb     -- additional loss attributable to the class beyond what the
 *                 path-loss model already accounts for. Empirical, and a
 *                 calibration parameter rather than a physical constant.
 *
 * The loss values below are representative starting points of the kind a
 * planning tool ships as defaults. In real use they are tuned against drive
 * test data per market and per band -- which is precisely why the model
 * exposes them as data rather than burying them in a formula.
 */

export type ClutterClass =
  | 'water'
  | 'open'
  | 'rural'
  | 'forest'
  | 'suburban'
  | 'urban'
  | 'dense-urban'
  | 'high-rise'
  | 'industrial';

export interface ClutterProperties {
  /** Representative clutter height, metres (ITU-R P.452 Table 4 / P.1812). */
  heightM: number;
  /** Additional path loss attributed to the class, dB. A calibration value. */
  lossDb: number;
  /** Indoor penetration loss for users inside buildings of this class, dB. */
  indoorLossDb: number;
  /** Fraction of users expected to be indoors, 0 to 1. Drives traffic modelling. */
  indoorFraction: number;
  /** Shadow-fading standard deviation, dB. Rises with environment clutter. */
  shadowSigmaDb: number;
}

export const CLUTTER: Record<ClutterClass, ClutterProperties> = {
  water: { heightM: 0, lossDb: -4, indoorLossDb: 0, indoorFraction: 0, shadowSigmaDb: 4 },
  open: { heightM: 0, lossDb: -3, indoorLossDb: 8, indoorFraction: 0.1, shadowSigmaDb: 5 },
  rural: { heightM: 6, lossDb: 0, indoorLossDb: 10, indoorFraction: 0.3, shadowSigmaDb: 6 },
  forest: { heightM: 15, lossDb: 6, indoorLossDb: 10, indoorFraction: 0.05, shadowSigmaDb: 8 },
  suburban: { heightM: 9, lossDb: 3, indoorLossDb: 12, indoorFraction: 0.6, shadowSigmaDb: 7 },
  urban: { heightM: 20, lossDb: 8, indoorLossDb: 18, indoorFraction: 0.7, shadowSigmaDb: 8 },
  'dense-urban': { heightM: 25, lossDb: 12, indoorLossDb: 22, indoorFraction: 0.8, shadowSigmaDb: 9 },
  'high-rise': { heightM: 35, lossDb: 15, indoorLossDb: 25, indoorFraction: 0.85, shadowSigmaDb: 10 },
  industrial: { heightM: 20, lossDb: 7, indoorLossDb: 20, indoorFraction: 0.4, shadowSigmaDb: 8 },
};

/** Returns the clutter class at a lat/lon. */
export type ClutterSampler = (latDeg: number, lonDeg: number) => ClutterClass;

/** A single-class sampler, for tests and for uniform-environment scenarios. */
export const uniformClutter = (cls: ClutterClass): ClutterSampler => () => cls;

/**
 * Indoor penetration loss for a given class and frequency.
 *
 * Building loss rises with frequency -- roughly 2 dB per octave in the
 * cellular range for traditional materials, and far more for the
 * infrared-reflective glass used in modern commercial buildings, which is why
 * mid-band 5G struggles indoors where 900 MHz did not. The reference point
 * here is 1800 MHz, where the per-class values above were taken.
 */
export function indoorLoss(cls: ClutterClass, freqMhz: number): number {
  const base = CLUTTER[cls].indoorLossDb;
  if (base <= 0) return 0;
  return base + 2 * Math.log2(Math.max(100, freqMhz) / 1800);
}
