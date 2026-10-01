/**
 * Radio refractivity, the effective Earth radius, and ray bending.
 *
 * This is the module that makes air density more than an attenuation knob.
 * The chain it implements:
 *
 *   pressure + temperature + humidity
 *     -> refractivity N                      (ITU-R P.453)
 *     -> vertical gradient dN/dh
 *     -> k-factor and effective Earth radius  (ITU-R P.310 / P.452)
 *     -> radio horizon distance and terrain bulge
 *     -> which towers a point can even see, and how much diffraction loss
 *        the ones over the horizon suffer
 *
 * So denser or more humid air does not merely absorb a bit more power. It
 * changes the geometry of the problem: a strong negative gradient traps rays
 * in a duct and carries a signal far past its nominal horizon, while a
 * sub-refractive layer pulls the horizon in and buries cells that a
 * flat-Earth model would have called fine. Operators see both, which is why
 * planning tools carry a k-factor field at all.
 */

import { DEG, EARTH_MEAN_RADIUS, RAD } from '../core/constants';
import { ISA_SURFACE, layerAltitudes, profileAt, type SurfaceConditions } from './isa';
import { vapourPressureFromDensity } from './humidity';

/**
 * Dry-air refractivity constant, K/hPa, for standard composition at the
 * reference CO2 level below.
 */
const K_DRY = 77.6;

/** Wet-term constant, K (ITU-R P.453 eq. 9: N = 77.6/T * (p + 4810 e/T)). */
const K_WET = 4810;

/** CO2 mole fraction the 77.6 constant is referenced to, ppm. */
const CO2_REFERENCE_PPM = 400;

/**
 * Sensitivity of dry-air refractivity to CO2 content.
 *
 * Refractivity scales with number density times mean molecular polarizability.
 * Replacing a mole fraction x of ambient air (mean static polarizability
 * ~1.71 A^3) with CO2 (~2.91 A^3) raises the mean by a factor of
 * (2.91 - 1.71)/1.71 = 0.70 per unit mole fraction.
 *
 * Deliberately recorded as a derived number, not a fitted one: at +400 ppm it
 * shifts N by well under 0.1 N-units, which is three orders of magnitude
 * below what water vapour does. It is wired in because the parameter exists
 * and should behave correctly, not because it will move the heatmap.
 */
const CO2_POLARIZABILITY_SENSITIVITY = 0.70;

export interface RefractivityInput {
  /** Total air pressure, hPa. */
  pressureHpa: number;
  /** Temperature, kelvin. */
  temperatureK: number;
  /** Water vapour density, g/m3. */
  waterVapourDensity: number;
  /** CO2 volume mixing ratio, ppm. Defaults to the present-day global mean. */
  co2Ppm?: number;
}

export interface Refractivity {
  /** Total refractivity, N-units (n = 1 + N x 1e-6). */
  n: number;
  /** Dry-air contribution, N-units. */
  dry: number;
  /** Water vapour contribution, N-units. */
  wet: number;
  /** Refractive index itself, dimensionless. */
  refractiveIndex: number;
}

/** Radio refractivity from the local atmospheric state (ITU-R P.453). */
export function refractivity(input: RefractivityInput): Refractivity {
  const { pressureHpa, temperatureK, waterVapourDensity } = input;
  const co2Ppm = input.co2Ppm ?? CO2_REFERENCE_PPM;

  const e = vapourPressureFromDensity(waterVapourDensity, temperatureK);
  const co2Scale =
    1 + CO2_POLARIZABILITY_SENSITIVITY * ((co2Ppm - CO2_REFERENCE_PPM) / 1e6);

  const dry = (K_DRY * co2Scale * (pressureHpa - e)) / temperatureK;
  const wet = (K_DRY * (e + (K_WET * e) / temperatureK)) / temperatureK;
  const n = dry + wet;

  return { n, dry, wet, refractiveIndex: 1 + n * 1e-6 };
}

/**
 * Vertical refractivity gradient near the surface, N-units per km.
 *
 * Taken over the first kilometre, which is the layer ITU-R P.452 and the
 * k-factor convention refer to. The gradient comes out of the profile rather
 * than being typed in, so it stays consistent with whatever pressure,
 * temperature and humidity the user set.
 */
export function refractivityGradient(
  surface: SurfaceConditions = ISA_SURFACE,
  co2Ppm = CO2_REFERENCE_PPM,
  layerThicknessM = 1_000,
): number {
  const lower = profileAt(surface.altM, surface);
  const upper = profileAt(surface.altM + layerThicknessM, surface);

  const nLower = refractivity({
    pressureHpa: lower.pressureHpa,
    temperatureK: lower.temperatureK,
    waterVapourDensity: lower.waterVapourDensity,
    co2Ppm,
  }).n;
  const nUpper = refractivity({
    pressureHpa: upper.pressureHpa,
    temperatureK: upper.temperatureK,
    waterVapourDensity: upper.waterVapourDensity,
    co2Ppm,
  }).n;

  return ((nUpper - nLower) / layerThicknessM) * 1000;
}

/** How a refractivity gradient classifies, in the standard propagation terms. */
export type RefractionRegime = 'sub-refractive' | 'normal' | 'super-refractive' | 'trapping';

/**
 * Classify a gradient.
 *
 * The boundaries are the conventional ones: -39 N/km is the standard
 * atmosphere, -157 N/km is where the ray curvature matches the Earth's own
 * and energy becomes trapped in a surface duct.
 */
export function refractionRegime(gradientNPerKm: number): RefractionRegime {
  if (gradientNPerKm <= -157) return 'trapping';
  if (gradientNPerKm <= -79) return 'super-refractive';
  if (gradientNPerKm <= -39) return 'normal';
  return 'sub-refractive';
}

/** Standard-atmosphere refractivity gradient, N-units/km. Yields k = 4/3. */
export const STANDARD_GRADIENT_N_PER_KM = -39;

/**
 * k-factor: the multiplier on Earth's radius that lets you draw rays as
 * straight lines over a curved-but-wrong Earth.
 *
 * k = 157 / (157 + dN/dh). The standard -39 N/km gives the familiar 4/3.
 * At the trapping boundary the denominator vanishes and k runs to infinity,
 * which is the flat-Earth limit: the ray follows the surface. Past it, k goes
 * negative and the straight-ray trick stops meaning anything, so the value is
 * clamped and the regime flag is what callers should branch on.
 */
export function kFactor(gradientNPerKm: number): number {
  const denominator = 157 + gradientNPerKm;
  if (denominator <= 1e-3) return 1e6;
  return 157 / denominator;
}

/** Effective Earth radius for straight-ray geometry, metres. */
export function effectiveEarthRadius(gradientNPerKm: number): number {
  return kFactor(gradientNPerKm) * EARTH_MEAN_RADIUS;
}

/**
 * Radio horizon distance from an antenna of a given height, metres.
 *
 * d = sqrt(2 k a h). Worth noting how strong this is: a 30 m tower sees
 * 22.6 km under the standard k = 4/3 but only 19.6 km if the gradient flattens
 * to zero. That is a fifth of the coverage radius lost to weather alone.
 */
export function radioHorizon(antennaHeightM: number, gradientNPerKm = STANDARD_GRADIENT_N_PER_KM): number {
  const ae = effectiveEarthRadius(gradientNPerKm);
  return Math.sqrt(2 * ae * Math.max(0, antennaHeightM));
}

/**
 * Earth bulge between two terminals at a point along the path, metres.
 *
 * This is what gets subtracted from a terrain profile before a diffraction
 * model runs: h = d1 d2 / (2 a_e). It is where the k-factor enters the
 * terrestrial link budget.
 */
export function earthBulge(
  d1M: number,
  d2M: number,
  gradientNPerKm = STANDARD_GRADIENT_N_PER_KM,
): number {
  return (d1M * d2M) / (2 * effectiveEarthRadius(gradientNPerKm));
}

/**
 * Total atmospheric refraction for a ray leaving at a given true elevation,
 * in degrees. Positive means the target appears higher than it geometrically is.
 *
 * Integrated rather than fitted. In a spherically stratified atmosphere
 * Bouguer's rule holds -- n * r * cos(theta) is constant along the ray -- and
 * the accumulated bending is
 *
 *   tau = -integral (dn/dr) / (n tan theta) dr
 *
 * which this evaluates over the layered profile. The payoff is that the
 * answer responds to the user's actual air density and humidity instead of to
 * a coefficient fitted for one reference atmosphere, and it degrades sensibly
 * at low elevation where satellite links live.
 */
export function refractionCorrection(
  trueElevationDeg: number,
  surface: SurfaceConditions = ISA_SURFACE,
  co2Ppm = CO2_REFERENCE_PPM,
  topAltM = 60_000,
): number {
  const el0 = Math.max(0, trueElevationDeg) * DEG;
  const layers = layerAltitudes(surface.altM, topAltM, 400);
  if (layers.length === 0) return 0;

  const nAt = (altM: number): number => {
    const air = profileAt(altM, surface);
    return refractivity({
      pressureHpa: air.pressureHpa,
      temperatureK: air.temperatureK,
      waterVapourDensity: air.waterVapourDensity,
      co2Ppm,
    }).refractiveIndex;
  };

  const r0 = EARTH_MEAN_RADIUS + surface.altM;
  const n0 = nAt(surface.altM);
  // Bouguer invariant for this ray.
  const bouguer = n0 * r0 * Math.cos(el0);

  let tau = 0;
  for (const layer of layers) {
    const r = EARTH_MEAN_RADIUS + layer.midAltM;
    const half = layer.thicknessM / 2;
    const nMid = nAt(layer.midAltM);
    const nLo = nAt(layer.midAltM - half);
    const nHi = nAt(layer.midAltM + half);
    const dndr = (nHi - nLo) / layer.thicknessM;

    const cosTheta = bouguer / (nMid * r);
    if (cosTheta >= 1) continue; // Ray has turned; nothing above contributes.
    const theta = Math.acos(Math.max(-1, cosTheta));
    const tanTheta = Math.tan(theta);
    if (!Number.isFinite(tanTheta) || Math.abs(tanTheta) < 1e-9) continue;

    tau += (-dndr / (nMid * tanTheta)) * layer.thicknessM;
  }

  return tau * RAD;
}

/** Apparent (refracted) elevation of a target at a given true elevation. */
export function apparentElevation(
  trueElevationDeg: number,
  surface: SurfaceConditions = ISA_SURFACE,
  co2Ppm = CO2_REFERENCE_PPM,
): number {
  return trueElevationDeg + refractionCorrection(trueElevationDeg, surface, co2Ppm);
}
