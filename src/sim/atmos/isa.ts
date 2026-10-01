/**
 * Vertical atmospheric structure.
 *
 * Two things live here:
 *   1. The International Standard Atmosphere, as a proper multi-layer
 *      hydrostatic model rather than the single troposphere approximation.
 *      It gives pressure, temperature and density at any altitude.
 *   2. A scaled profile: take the user's measured surface conditions and
 *      extend them upward with ISA lapse rates and the ITU-R P.835 water
 *      vapour scale height.
 *
 * Why the profile matters: gaseous absorption and refractivity are both
 * integrals along a slant path through a layered atmosphere, not a single
 * surface value multiplied by a distance. Getting the profile right is what
 * makes the air-density and humidity controls behave like weather instead of
 * like an opacity slider.
 */

import { G_STANDARD, R_DRY_AIR } from '../core/constants';

/** One ISA layer, keyed by its geopotential base altitude. */
interface IsaLayer {
  /** Geopotential base altitude, metres. */
  baseAltM: number;
  /** Temperature at the base, kelvin. */
  baseTempK: number;
  /** Pressure at the base, pascals. */
  basePressurePa: number;
  /** Temperature lapse rate, K/m. Positive means warming with height. */
  lapseRateKPerM: number;
}

/**
 * ISA layers (ISO 2533). Base pressures are the standard published values, so
 * the model is continuous across layer boundaries without re-deriving them.
 */
const ISA_LAYERS: readonly IsaLayer[] = [
  { baseAltM: 0, baseTempK: 288.15, basePressurePa: 101_325, lapseRateKPerM: -0.0065 },
  { baseAltM: 11_000, baseTempK: 216.65, basePressurePa: 22_632.1, lapseRateKPerM: 0 },
  { baseAltM: 20_000, baseTempK: 216.65, basePressurePa: 5_474.89, lapseRateKPerM: 0.001 },
  { baseAltM: 32_000, baseTempK: 228.65, basePressurePa: 868.019, lapseRateKPerM: 0.0028 },
  { baseAltM: 47_000, baseTempK: 270.65, basePressurePa: 110.906, lapseRateKPerM: 0 },
  { baseAltM: 51_000, baseTempK: 270.65, basePressurePa: 66.9389, lapseRateKPerM: -0.0028 },
  { baseAltM: 71_000, baseTempK: 214.65, basePressurePa: 3.95642, lapseRateKPerM: -0.002 },
];

/** Water vapour scale height, metres (ITU-R P.835 reference atmosphere). */
export const WATER_VAPOUR_SCALE_HEIGHT = 2_000;

/** Reference surface water vapour density, g/m3 (ITU-R P.835 mean global). */
export const WATER_VAPOUR_SURFACE_REF = 7.5;

export interface AirSample {
  /** Altitude above mean sea level, metres. */
  altM: number;
  /** Total air pressure, hPa. */
  pressureHpa: number;
  /** Temperature, kelvin. */
  temperatureK: number;
  /** Total air density, kg/m3. */
  densityKgM3: number;
  /** Water vapour density, g/m3. */
  waterVapourDensity: number;
}

/** Pressure and temperature of the standard atmosphere at an altitude. */
export function isaAt(altM: number): { pressurePa: number; temperatureK: number } {
  const h = Math.max(0, Math.min(altM, 84_852));
  let layer = ISA_LAYERS[0]!;
  for (const candidate of ISA_LAYERS) {
    if (h >= candidate.baseAltM) layer = candidate;
    else break;
  }

  const dh = h - layer.baseAltM;
  const temperatureK = layer.baseTempK + layer.lapseRateKPerM * dh;

  let pressurePa: number;
  if (layer.lapseRateKPerM === 0) {
    pressurePa =
      layer.basePressurePa * Math.exp((-G_STANDARD * dh) / (R_DRY_AIR * layer.baseTempK));
  } else {
    const exponent = -G_STANDARD / (layer.lapseRateKPerM * R_DRY_AIR);
    pressurePa = layer.basePressurePa * (temperatureK / layer.baseTempK) ** exponent;
  }

  return { pressurePa, temperatureK };
}

/** Dry-air density from pressure and temperature via the ideal gas law, kg/m3. */
export function airDensity(pressureHpa: number, temperatureK: number): number {
  return (pressureHpa * 100) / (R_DRY_AIR * temperatureK);
}

/**
 * The inverse: what pressure gives this density at this temperature.
 *
 * This is the hook that makes "air density" a usable control. A user who sets
 * a density is implicitly setting a pressure, and that pressure then flows
 * into oxygen absorption and refractivity. Treating density as an independent
 * free parameter would break the gas law and quietly decouple the physics.
 */
export function pressureFromDensity(densityKgM3: number, temperatureK: number): number {
  return (densityKgM3 * R_DRY_AIR * temperatureK) / 100;
}

/** Surface conditions a profile is anchored to. */
export interface SurfaceConditions {
  /** Surface pressure, hPa. */
  pressureHpa: number;
  /** Surface temperature, kelvin. */
  temperatureK: number;
  /** Surface water vapour density, g/m3. */
  waterVapourDensity: number;
  /** Surface altitude above mean sea level, metres. */
  altM: number;
}

/** ISA surface conditions, for a clear reference baseline. */
export const ISA_SURFACE: SurfaceConditions = {
  pressureHpa: 1013.25,
  temperatureK: 288.15,
  waterVapourDensity: WATER_VAPOUR_SURFACE_REF,
  altM: 0,
};

/**
 * Sample the atmosphere at an altitude, anchored to measured surface
 * conditions.
 *
 * Temperature follows the ISA lapse rate from the surface value. Pressure
 * follows the ISA shape, scaled so it matches the surface reading exactly.
 * Water vapour decays exponentially with the P.835 scale height. The result
 * is a profile that is hydrostatically sane and honours what the user set at
 * the ground, which is what a weather station or a sounding actually gives.
 */
export function profileAt(altM: number, surface: SurfaceConditions = ISA_SURFACE): AirSample {
  const h = Math.max(surface.altM, altM);
  const isaHere = isaAt(h);
  const isaSurface = isaAt(surface.altM);

  const pressureScale = (surface.pressureHpa * 100) / isaSurface.pressurePa;
  const pressureHpa = (isaHere.pressurePa * pressureScale) / 100;
  const temperatureK = isaHere.temperatureK + (surface.temperatureK - isaSurface.temperatureK);

  const waterVapourDensity =
    surface.waterVapourDensity * Math.exp(-(h - surface.altM) / WATER_VAPOUR_SCALE_HEIGHT);

  return {
    altM: h,
    pressureHpa,
    temperatureK,
    densityKgM3: airDensity(pressureHpa, temperatureK),
    waterVapourDensity,
  };
}

/**
 * Layer a slant path through the atmosphere for numerical integration.
 *
 * Layer thickness grows geometrically with altitude: the first layers are
 * ~10 m thick where the gas is dense and the gradient is steep, widening
 * higher up where the contribution is small. This buys accuracy near the
 * ground, which is where almost all of the absorption happens, without
 * paying for thousands of uniform layers.
 */
export function layerAltitudes(
  fromAltM: number,
  toAltM: number,
  layerCount = 120,
): { midAltM: number; thicknessM: number }[] {
  const lo = Math.min(fromAltM, toAltM);
  const hi = Math.max(fromAltM, toAltM);
  const span = hi - lo;
  if (span <= 0) return [];

  const n = Math.max(1, Math.floor(layerCount));
  // Geometric growth factor chosen so the layers sum exactly to the span.
  const growth = 1.03;
  let unitSum = 0;
  const units: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = growth ** i;
    units.push(u);
    unitSum += u;
  }

  const out: { midAltM: number; thicknessM: number }[] = [];
  let cursor = lo;
  for (let i = 0; i < n; i++) {
    const thicknessM = (units[i]! / unitSum) * span;
    out.push({ midAltM: cursor + thicknessM / 2, thicknessM });
    cursor += thicknessM;
  }
  return out;
}
