/**
 * Empirical macro-cell path loss models.
 *
 *   Okumura-Hata  150 to 1500 MHz. The original, fitted to Tokyo drive tests
 *                 in the 1960s and still the reference for sub-GHz coverage
 *                 bands like the 900 MHz and 850 MHz layers.
 *   COST-231 Hata 1500 to 2000 MHz. The European extension that made Hata
 *                 usable for the 1800 MHz and 2100 MHz bands.
 *   SPM           The Standard Propagation Model: a linear combination of
 *                 log-distance, antenna-height and diffraction terms whose
 *                 coefficients are fitted per market. This is what commercial
 *                 planning tools actually predict with, because it can be
 *                 calibrated against drive-test data in a way a fixed formula
 *                 cannot.
 *
 * On validity ranges: these models are curve fits, and outside their fitted
 * range they do not degrade gracefully, they go wrong. Each function reports
 * whether the inputs were in range rather than silently extrapolating, so the
 * simulator can mark a prediction as out-of-model instead of presenting a
 * confident wrong number.
 */

import { freeSpacePathLoss } from './fspl';
import { CLUTTER, type ClutterClass } from './clutter';

export interface PathLossResult {
  /** Total path loss, dB. */
  lossDb: number;
  /** False when at least one input sat outside the model's fitted range. */
  inRange: boolean;
  /** Human-readable notes on any range violations. */
  warnings: string[];
}

/** Mobile-station height correction term a(h_m), shared by Hata and COST-231. */
function mobileHeightCorrection(freqMhz: number, mobileHeightM: number): number {
  const logF = Math.log10(freqMhz);
  return (1.1 * logF - 0.7) * mobileHeightM - (1.56 * logF - 0.8);
}

export type HataEnvironment = 'urban' | 'suburban' | 'open';

/**
 * Okumura-Hata path loss, dB.
 *
 * Fitted range: 150 to 1500 MHz, 1 to 20 km, base height 30 to 200 m, mobile
 * height 1 to 10 m.
 */
export function okumuraHata(params: {
  freqMhz: number;
  distanceM: number;
  baseHeightM: number;
  mobileHeightM: number;
  environment?: HataEnvironment;
}): PathLossResult {
  const { freqMhz, distanceM, baseHeightM, mobileHeightM, environment = 'urban' } = params;
  const warnings: string[] = [];

  if (freqMhz < 150 || freqMhz > 1500) warnings.push('frequency outside 150-1500 MHz');
  if (distanceM < 1000 || distanceM > 20_000) warnings.push('distance outside 1-20 km');
  if (baseHeightM < 30 || baseHeightM > 200) warnings.push('base height outside 30-200 m');
  if (mobileHeightM < 1 || mobileHeightM > 10) warnings.push('mobile height outside 1-10 m');

  const dKm = Math.max(0.001, distanceM / 1000);
  const hb = Math.max(1, baseHeightM);
  const logF = Math.log10(freqMhz);
  const logHb = Math.log10(hb);

  const urban =
    69.55 +
    26.16 * logF -
    13.82 * logHb -
    mobileHeightCorrection(freqMhz, mobileHeightM) +
    (44.9 - 6.55 * logHb) * Math.log10(dKm);

  let lossDb = urban;
  if (environment === 'suburban') {
    lossDb = urban - 2 * Math.log10(freqMhz / 28) ** 2 - 5.4;
  } else if (environment === 'open') {
    lossDb = urban - 4.78 * logF ** 2 + 18.33 * logF - 40.94;
  }

  return { lossDb, inRange: warnings.length === 0, warnings };
}

/**
 * COST-231 Hata path loss, dB.
 *
 * Fitted range: 1500 to 2000 MHz. Routinely applied up to 2600 MHz in
 * practice, which is extrapolation -- flagged rather than hidden.
 *
 * metropolitan adds the 3 dB city-centre correction C_m. The distinction is
 * between a dense core of continuous tall building and a merely built-up
 * area; it is a judgement call, and in a planning tool it comes from the
 * clutter raster rather than a checkbox.
 */
export function cost231Hata(params: {
  freqMhz: number;
  distanceM: number;
  baseHeightM: number;
  mobileHeightM: number;
  metropolitan?: boolean;
}): PathLossResult {
  const { freqMhz, distanceM, baseHeightM, mobileHeightM, metropolitan = false } = params;
  const warnings: string[] = [];

  if (freqMhz < 1500 || freqMhz > 2000) warnings.push('frequency outside 1500-2000 MHz');
  if (distanceM < 1000 || distanceM > 20_000) warnings.push('distance outside 1-20 km');
  if (baseHeightM < 30 || baseHeightM > 200) warnings.push('base height outside 30-200 m');

  const dKm = Math.max(0.001, distanceM / 1000);
  const hb = Math.max(1, baseHeightM);
  const logHb = Math.log10(hb);

  const lossDb =
    46.3 +
    33.9 * Math.log10(freqMhz) -
    13.82 * logHb -
    mobileHeightCorrection(freqMhz, mobileHeightM) +
    (44.9 - 6.55 * logHb) * Math.log10(dKm) +
    (metropolitan ? 3 : 0);

  return { lossDb, inRange: warnings.length === 0, warnings };
}

/**
 * Standard Propagation Model coefficients.
 *
 * L = K1
 *   + K2 log10(d_km)
 *   + K3 log10(h_tx_eff)
 *   + K4 * diffractionLoss
 *   + K5 log10(d_km) log10(h_tx_eff)
 *   + K6 h_rx_eff
 *   + clutterLoss
 *
 * Every K is a calibration parameter. The defaults below are not universal
 * constants -- they are a sane starting point that an engineer then fits to
 * drive-test data, which is the entire reason this model shape exists.
 */
export interface SpmCoefficients {
  /** Constant offset, dB. Absorbs frequency and environment. */
  k1: number;
  /** Log-distance slope. 44.9 is the Hata-family value. */
  k2: number;
  /** Effective transmitter height gain. */
  k3: number;
  /** Weight on the computed diffraction loss, 0 to 1. */
  k4: number;
  /** Distance-height cross term. Negative: taller masts flatten the slope. */
  k5: number;
  /** Receiver height term, dB/m. */
  k6: number;
}

/**
 * Default SPM coefficients, calibrated so the model reproduces COST-231 Hata
 * at the reference geometry (1 km, 30 m mast, 1.5 m mobile, urban clutter).
 *
 * Anchoring to a published model rather than inventing K1 means the defaults
 * are traceable: if SPM and COST-231 disagree at the reference point, that is
 * a bug, and the test suite checks it.
 */
export function spmDefaults(freqMhz: number, metropolitan = false): SpmCoefficients {
  const k2 = 44.9;
  const k3 = 5.83;
  const k4 = 0.5;
  const k5 = -6.55;
  const k6 = 0;

  // Solve K1 from the reference point.
  const refDistanceKm = 1;
  const refHTx = 30;
  const refHRx = 1.5;
  const reference = cost231Hata({
    freqMhz: Math.min(2000, Math.max(1500, freqMhz)),
    distanceM: refDistanceKm * 1000,
    baseHeightM: refHTx,
    mobileHeightM: refHRx,
    metropolitan,
  }).lossDb;

  // Correct the frequency back out to the requested band with the Hata slope.
  const freqAdjust = 33.9 * Math.log10(freqMhz / Math.min(2000, Math.max(1500, freqMhz)));

  const logHTx = Math.log10(refHTx);
  const structural =
    k2 * Math.log10(refDistanceKm) +
    k3 * logHTx +
    k5 * Math.log10(refDistanceKm) * logHTx +
    k6 * refHRx +
    CLUTTER.urban.lossDb;

  return { k1: reference + freqAdjust - structural, k2, k3, k4, k5, k6 };
}

/**
 * Standard Propagation Model path loss, dB.
 *
 * Unlike Hata this one takes a diffraction loss as an input rather than
 * pretending terrain does not exist -- which is what makes it usable over
 * real geography and why planning tools default to it.
 */
export function standardPropagationModel(params: {
  freqMhz: number;
  distanceM: number;
  /** Effective transmitter height above the local terrain, metres. */
  txHeightEffM: number;
  /** Receiver height above ground, metres. */
  rxHeightM: number;
  /** Diffraction loss from the terrain profile, dB. */
  diffractionLossDb: number;
  clutter: ClutterClass;
  coefficients?: SpmCoefficients;
  metropolitan?: boolean;
}): PathLossResult {
  const {
    freqMhz,
    distanceM,
    txHeightEffM,
    rxHeightM,
    diffractionLossDb,
    clutter,
    metropolitan = false,
  } = params;

  const k = params.coefficients ?? spmDefaults(freqMhz, metropolitan);
  const dKm = Math.max(0.001, distanceM / 1000);
  const logD = Math.log10(dKm);
  const logHTx = Math.log10(Math.max(1, txHeightEffM));

  const lossDb =
    k.k1 +
    k.k2 * logD +
    k.k3 * logHTx +
    k.k4 * diffractionLossDb +
    k.k5 * logD * logHTx +
    k.k6 * rxHeightM +
    CLUTTER[clutter].lossDb;

  const warnings: string[] = [];
  if (distanceM < 100) warnings.push('distance below 100 m: near field, model not applicable');

  // Free space is a hard floor. If the calibrated model dips below it,
  // something is wrong with the coefficients and the caller should know.
  const fspl = freeSpacePathLoss(distanceM, freqMhz);
  if (lossDb < fspl) {
    warnings.push('model predicts less loss than free space; coefficients need review');
    return { lossDb: fspl, inRange: false, warnings };
  }

  return { lossDb, inRange: warnings.length === 0, warnings };
}
