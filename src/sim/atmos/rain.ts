/**
 * Rain attenuation.
 *
 *   ITU-R P.838-3  specific attenuation from rain rate
 *   ITU-R P.839-4  rain height from the 0 degC isotherm
 *   ITU-R P.618-13 Earth-space path attenuation and availability
 *   ITU-R P.530-18 terrestrial path attenuation
 *
 * Rain is the dominant fade mechanism above roughly 10 GHz, which is exactly
 * where Ku and Ka satellite links and millimetre backhaul live. It is also
 * the reason link budgets carry a margin at all: the design question is never
 * "how much does rain cost" but "what fraction of the year does rain cost
 * more than my margin", so the percentage-of-time scaling here matters as
 * much as the attenuation itself.
 */

import { DEG, EARTH_MEAN_RADIUS, RAD } from '../core/constants';

/** One Gaussian term of the P.838 coefficient fits. */
interface GaussianFit {
  readonly a: readonly number[];
  readonly b: readonly number[];
  readonly c: readonly number[];
  /** Linear coefficient on log10(f). */
  readonly m: number;
  /** Constant offset. */
  readonly k: number;
}

/**
 * ITU-R P.838-3 Tables 1 to 4.
 *
 * log10(k) and alpha are each a sum of Gaussians in log10(f) plus a linear
 * term, which is why these read as coefficient soup: they are a published
 * curve fit to scattering computations over drop-size distributions, not a
 * closed-form physical law.
 */
const K_HORIZONTAL: GaussianFit = {
  a: [-5.3398, -0.35351, -0.23789, -0.94158],
  b: [-0.10008, 1.2697, 0.86036, 0.64552],
  c: [1.13098, 0.454, 0.15354, 0.16817],
  m: -0.18961,
  k: 0.71147,
};

const K_VERTICAL: GaussianFit = {
  a: [-3.80595, -3.44965, -0.39902, 0.50167],
  b: [0.56934, -0.22911, 0.73042, 1.07319],
  c: [0.81061, 0.51059, 0.11899, 0.27195],
  m: -0.16398,
  k: 0.63297,
};

const ALPHA_HORIZONTAL: GaussianFit = {
  a: [-0.14318, 0.29591, 0.32177, -5.3761, 16.1721],
  b: [1.82442, 0.77564, 0.63773, -0.9623, -3.2998],
  c: [-0.55187, 0.19822, 0.13164, 1.47828, 3.4399],
  m: 0.67849,
  k: -1.95537,
};

const ALPHA_VERTICAL: GaussianFit = {
  a: [-0.07771, 0.56727, -0.20238, -48.2991, 48.5833],
  b: [2.3384, 0.95545, 1.1452, 0.791669, 0.791459],
  c: [-0.76284, 0.54039, 0.26809, 0.116226, 0.116479],
  m: -0.053739,
  k: 0.83433,
};

function evaluateFit(fit: GaussianFit, freqGHz: number): number {
  const logF = Math.log10(freqGHz);
  let sum = 0;
  for (let j = 0; j < fit.a.length; j++) {
    const z = (logF - fit.b[j]!) / fit.c[j]!;
    sum += fit.a[j]! * Math.exp(-z * z);
  }
  return sum + fit.m * logF + fit.k;
}

export interface RainCoefficients {
  /** Multiplier k in gamma = k R^alpha. */
  k: number;
  /** Exponent alpha. */
  alpha: number;
}

/**
 * P.838-3 coefficients for a given frequency, path elevation and polarization
 * tilt.
 *
 * tauDeg is the polarization tilt from horizontal: 0 for horizontal, 90 for
 * vertical, 45 for circular. Rain drops are oblate, so horizontal
 * polarization attenuates more -- which is why satellite systems that care
 * about rain margin prefer circular or vertical.
 *
 * Valid 1 to 1000 GHz.
 */
export function rainCoefficients(
  freqGHz: number,
  elevationDeg: number,
  tauDeg = 45,
): RainCoefficients {
  const kH = 10 ** evaluateFit(K_HORIZONTAL, freqGHz);
  const kV = 10 ** evaluateFit(K_VERTICAL, freqGHz);
  const aH = evaluateFit(ALPHA_HORIZONTAL, freqGHz);
  const aV = evaluateFit(ALPHA_VERTICAL, freqGHz);

  const cos2El = Math.cos(elevationDeg * DEG) ** 2;
  const cos2Tau = Math.cos(2 * tauDeg * DEG);

  const k = (kH + kV + (kH - kV) * cos2El * cos2Tau) / 2;
  const alpha = (kH * aH + kV * aV + (kH * aH - kV * aV) * cos2El * cos2Tau) / (2 * k);

  return { k, alpha };
}

/** Specific attenuation from rain, dB/km. gamma = k R^alpha (P.838). */
export function rainSpecificAttenuation(
  rainRateMmH: number,
  freqGHz: number,
  elevationDeg: number,
  tauDeg = 45,
): number {
  if (rainRateMmH <= 0) return 0;
  const { k, alpha } = rainCoefficients(freqGHz, elevationDeg, tauDeg);
  return k * rainRateMmH ** alpha;
}

/**
 * Rain height above mean sea level, metres (P.839).
 *
 * h_R = h_0 + 360 m, where h_0 is the mean annual 0 degC isotherm height.
 * The current recommendation ships h_0 as a global raster; until that raster
 * is loaded, this falls back to the latitude-dependent approximation of
 * P.839-2. For India (8 to 37 degN) the two agree to a few hundred metres,
 * which moves Ka-band rain attenuation by under a decibel.
 */
export function rainHeight(latDeg: number, isothermHeightM?: number): number {
  if (isothermHeightM !== undefined) return isothermHeightM + 360;
  const absLat = Math.abs(latDeg);
  const h0Km = absLat <= 23 ? 5.0 : Math.max(0, 5.0 - 0.075 * (absLat - 23));
  return h0Km * 1000 + 360;
}

export interface EarthSpaceRainResult {
  /** Attenuation exceeded for 0.01% of an average year, dB. */
  a001Db: number;
  /** Attenuation exceeded for the requested percentage of time, dB. */
  attenuationDb: number;
  /** Effective path length through rain, km. */
  effectivePathKm: number;
  /** Specific attenuation used, dB/km. */
  specificAttenuationDbKm: number;
}

/**
 * Earth-space rain attenuation, ITU-R P.618-13 section 2.2.1.1.
 *
 * The chain is geometric before it is statistical: find how far the slant
 * path travels below the rain height, shrink it horizontally because a storm
 * cell is not uniform over tens of kilometres, adjust it vertically, then
 * multiply by the specific attenuation. Only at the end does the result get
 * scaled from the 0.01% reference to the percentage of time asked for.
 */
export function earthSpaceRainAttenuation(params: {
  /** Frequency, GHz. */
  freqGHz: number;
  /** Path elevation angle, degrees. */
  elevationDeg: number;
  /** Station latitude, degrees. */
  latDeg: number;
  /** Station height above mean sea level, metres. */
  stationAltM: number;
  /** Rain rate exceeded 0.01% of an average year, mm/h (from P.837). */
  rain001MmH: number;
  /** Percentage of an average year for the answer, 0.001 to 5. */
  percentOfTime?: number;
  /** Polarization tilt from horizontal, degrees. */
  tauDeg?: number;
  /** 0 degC isotherm height, metres, if the P.839 raster is available. */
  isothermHeightM?: number;
}): EarthSpaceRainResult {
  const {
    freqGHz,
    elevationDeg,
    latDeg,
    stationAltM,
    rain001MmH,
    percentOfTime = 0.01,
    tauDeg = 45,
    isothermHeightM,
  } = params;

  if (rain001MmH <= 0) {
    return { a001Db: 0, attenuationDb: 0, effectivePathKm: 0, specificAttenuationDbKm: 0 };
  }

  const hRM = rainHeight(latDeg, isothermHeightM);
  const hRKm = hRM / 1000;
  const hsKm = stationAltM / 1000;
  const deltaHKm = hRKm - hsKm;

  if (deltaHKm <= 0) {
    // Station sits above the rain layer: nothing to integrate through.
    return { a001Db: 0, attenuationDb: 0, effectivePathKm: 0, specificAttenuationDbKm: 0 };
  }

  const theta = Math.max(0.1, elevationDeg) * DEG;
  const sinTheta = Math.sin(theta);

  // Step 2: slant path length below the rain height, km.
  const reKm = EARTH_MEAN_RADIUS / 1000;
  const lsKm =
    elevationDeg >= 5
      ? deltaHKm / sinTheta
      : (2 * deltaHKm) / (Math.sqrt(sinTheta * sinTheta + (2 * deltaHKm) / reKm) + sinTheta);

  // Step 3: horizontal projection.
  const lgKm = lsKm * Math.cos(theta);

  // Step 5: specific attenuation at the 0.01% rain rate.
  const { k, alpha } = rainCoefficients(freqGHz, elevationDeg, tauDeg);
  const gammaR = k * rain001MmH ** alpha;

  // Step 6: horizontal reduction factor -- storm cells are not uniform.
  const r001 =
    1 /
    (1 + 0.78 * Math.sqrt((lgKm * gammaR) / freqGHz) - 0.38 * (1 - Math.exp(-2 * lgKm)));

  // Step 7: vertical adjustment factor.
  const zeta = Math.atan2(deltaHKm, lgKm * r001);
  const lrKm = zeta * RAD > elevationDeg ? (lgKm * r001) / Math.cos(theta) : deltaHKm / sinTheta;
  const chi = Math.abs(latDeg) < 36 ? 36 - Math.abs(latDeg) : 0;
  const v001 =
    1 /
    (1 +
      Math.sqrt(sinTheta) *
        (31 * (1 - Math.exp(-(elevationDeg / (1 + chi)))) *
          (Math.sqrt(lrKm * gammaR) / (freqGHz * freqGHz)) -
          0.45));

  // Step 8 and 9: effective path length and the 0.01% attenuation.
  const leKm = lrKm * v001;
  const a001Db = gammaR * leKm;

  // Step 10: scale to the requested exceedance percentage.
  const p = Math.min(5, Math.max(0.001, percentOfTime));
  let beta = 0;
  if (p < 1 && Math.abs(latDeg) < 36) {
    beta = elevationDeg >= 25 ? -0.005 * (Math.abs(latDeg) - 36) : -0.005 * (Math.abs(latDeg) - 36) + 1.8 - 4.25 * sinTheta;
  }
  const exponent =
    -(0.655 + 0.033 * Math.log(p) - 0.045 * Math.log(Math.max(1e-6, a001Db)) - beta * (1 - p) * sinTheta);
  const attenuationDb = p === 0.01 ? a001Db : a001Db * (p / 0.01) ** exponent;

  return {
    a001Db,
    attenuationDb,
    effectivePathKm: leKm,
    specificAttenuationDbKm: gammaR,
  };
}

/**
 * Terrestrial rain attenuation, ITU-R P.530-18 section 2.4.1.
 *
 * Same idea as the Earth-space case but with a distance-dependent path
 * reduction factor instead of a two-stage geometric one, because a horizontal
 * link lies entirely inside the rain cell layer.
 */
export function terrestrialRainAttenuation(params: {
  freqGHz: number;
  /** Path length, km. */
  distanceKm: number;
  /** Rain rate exceeded 0.01% of an average year, mm/h. */
  rain001MmH: number;
  /** Percentage of an average year, 0.001 to 1. */
  percentOfTime?: number;
  /** Polarization tilt from horizontal, degrees. */
  tauDeg?: number;
}): { a001Db: number; attenuationDb: number; effectiveDistanceKm: number } {
  const { freqGHz, distanceKm, rain001MmH, percentOfTime = 0.01, tauDeg = 0 } = params;

  if (rain001MmH <= 0 || distanceKm <= 0) {
    return { a001Db: 0, attenuationDb: 0, effectiveDistanceKm: 0 };
  }

  const { k, alpha } = rainCoefficients(freqGHz, 0, tauDeg);
  const gammaR = k * rain001MmH ** alpha;

  const d = distanceKm;
  const denominator =
    0.477 * d ** 0.633 * rain001MmH ** (0.073 * alpha) * freqGHz ** 0.123 -
    10.579 * (1 - Math.exp(-0.024 * d));
  const r = Math.min(2.5, denominator > 0 ? 1 / denominator : 2.5);
  const effectiveDistanceKm = d * r;
  const a001Db = gammaR * effectiveDistanceKm;

  const p = Math.min(1, Math.max(0.001, percentOfTime));
  const c0 = freqGHz >= 10 ? 0.12 + 0.4 * Math.log10((freqGHz / 10) ** 0.8) : 0.12;
  const c1 = 0.07 ** c0 * 0.12 ** (1 - c0);
  const c2 = 0.855 * c0 + 0.546 * (1 - c0);
  const c3 = 0.139 * c0 + 0.043 * (1 - c0);
  const ratio = c1 * p ** -(c2 + c3 * Math.log10(p));

  return {
    a001Db,
    attenuationDb: p === 0.01 ? a001Db : a001Db * ratio,
    effectiveDistanceKm,
  };
}
