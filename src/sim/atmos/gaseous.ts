/**
 * Gaseous absorption by dry air and water vapour: ITU-R P.676.
 *
 * Implements the Annex 2 specific-attenuation approximation for the oxygen
 * and water-vapour terms, then integrates it along a slant path through the
 * layered profile rather than using the Annex 2 equivalent-height shortcut.
 *
 * Why integrate instead of using equivalent heights: the equivalent-height
 * expressions are fitted for the reference atmosphere. The whole point of
 * exposing pressure, temperature and humidity as controls is that the user
 * can leave the reference atmosphere, so a path integral through the actual
 * profile is both more accurate under those conditions and simpler to reason
 * about. The spherical geometry also lets low-elevation satellite links --
 * where the air mass grows fastest and the interesting failures happen --
 * come out right instead of degrading as 1/sin(theta).
 *
 * Frequency range: 1 to 54 GHz. That spans every terrestrial cellular band
 * and Ku/K/Ka satellite band. Above 54 GHz the recommendation switches to
 * different branches around the 60 GHz oxygen complex, which are deliberately
 * not implemented here -- the function reports NaN rather than extrapolating
 * a formula outside its stated validity.
 */

import { DEG, EARTH_MEAN_RADIUS } from '../core/constants';
import { ISA_SURFACE, layerAltitudes, profileAt, type SurfaceConditions } from './isa';
import { refractivity } from './refractivity';

/** Upper frequency bound of the implemented P.676 branch, GHz. */
export const GASEOUS_MAX_FREQ_GHZ = 54;

/** Lower frequency bound, GHz. Below this, gaseous absorption is negligible anyway. */
export const GASEOUS_MIN_FREQ_GHZ = 1;

/** The phi() helper of P.676 Annex 2: r_p^a * r_t^b * exp[c(1-r_p) + d(1-r_t)]. */
function phi(rp: number, rt: number, a: number, b: number, c: number, d: number): number {
  return rp ** a * rt ** b * Math.exp(c * (1 - rp) + d * (1 - rt));
}

/** The line-shape correction g(f, fi) = 1 + ((f - fi)/(f + fi))^2. */
function g(f: number, fi: number): number {
  const r = (f - fi) / (f + fi);
  return 1 + r * r;
}

/**
 * Specific attenuation from dry air (the oxygen complex plus the pressure
 * continuum), dB/km. P.676 Annex 2, the f <= 54 GHz branch.
 */
export function oxygenSpecificAttenuation(
  freqGHz: number,
  pressureHpa: number,
  temperatureK: number,
): number {
  if (freqGHz > GASEOUS_MAX_FREQ_GHZ) return Number.NaN;

  const f = freqGHz;
  const rp = pressureHpa / 1013;
  const rt = 288 / temperatureK;

  const xi1 = phi(rp, rt, 0.0717, -1.8132, 0.0156, -1.6515);
  const xi2 = phi(rp, rt, 0.5146, -4.6368, -0.1921, -5.7416);
  const xi3 = phi(rp, rt, 0.3414, -6.5851, 0.213, -8.5854);

  const term1 = (7.2 * rt ** 2.8) / (f * f + 0.34 * rp * rp * rt ** 1.6);
  const term2 = (0.62 * xi3) / ((54 - f) ** (1.16 * xi1) + 0.83 * xi2);

  return (term1 + term2) * f * f * rp * rp * 1e-3;
}

/**
 * Specific attenuation from water vapour, dB/km. P.676 Annex 2.
 *
 * All nine resonance terms are kept even though only the 22.235 GHz line sits
 * inside our band: the far-wing contributions of the 557 GHz and 1780 GHz
 * lines are not negligible at low frequency -- at 1.8 GHz they together
 * outweigh the 22 GHz line -- and dropping them would bias the continuum.
 */
export function waterVapourSpecificAttenuation(
  freqGHz: number,
  pressureHpa: number,
  temperatureK: number,
  waterVapourDensity: number,
): number {
  if (freqGHz > GASEOUS_MAX_FREQ_GHZ) return Number.NaN;

  const f = freqGHz;
  const rp = pressureHpa / 1013;
  const rt = 288 / temperatureK;
  const rho = waterVapourDensity;

  const eta1 = 0.955 * rp * rt ** 0.68 + 0.006 * rho;
  const eta2 = 0.735 * rp * rt ** 0.5 + 0.0353 * rt ** 4 * rho;

  const lorentz = (strength: number, tExp: number, centre: number, width: number): number =>
    (strength * eta1 * Math.exp(tExp * (1 - rt))) /
    ((f - centre) ** 2 + width * eta1 * eta1);

  const wing = (strength: number, tExp: number, centre: number, eta: number): number =>
    (strength * eta * Math.exp(tExp * (1 - rt))) / (f - centre) ** 2;

  const sum =
    lorentz(3.98, 2.23, 22.235, 9.42) * g(f, 22) +
    lorentz(11.96, 0.7, 183.31, 11.14) +
    lorentz(0.081, 6.44, 321.226, 6.29) +
    lorentz(3.66, 1.6, 325.153, 9.22) +
    wing(25.37, 1.09, 380, eta1) +
    wing(17.4, 1.46, 448, eta1) +
    wing(844.6, 0.17, 557, eta1) * g(f, 557) +
    wing(290.0, 0.41, 752, eta1) * g(f, 752) +
    wing(83_328, 0.99, 1780, eta2) * g(f, 1780);

  return sum * f * f * rt ** 2.5 * rho * 1e-4;
}

/** Total gaseous specific attenuation at a point, dB/km. */
export function gaseousSpecificAttenuation(
  freqGHz: number,
  pressureHpa: number,
  temperatureK: number,
  waterVapourDensity: number,
): number {
  return (
    oxygenSpecificAttenuation(freqGHz, pressureHpa, temperatureK) +
    waterVapourSpecificAttenuation(freqGHz, pressureHpa, temperatureK, waterVapourDensity)
  );
}

export interface SlantGaseousResult {
  /** Total gaseous attenuation along the path, dB. */
  totalDb: number;
  /** Dry-air share, dB. */
  oxygenDb: number;
  /** Water-vapour share, dB. */
  waterVapourDb: number;
  /** Geometric path length through the modelled atmosphere, metres. */
  pathLengthM: number;
}

/**
 * Gaseous attenuation for an Earth-space path.
 *
 * The slant factor comes from Bouguer's invariant in a spherically stratified
 * medium: n0 r0 cos(theta0) = n r cos(theta), so the path length through a
 * layer is dr / sin(theta) with the local theta, not the one at the ground.
 * At 90 degrees this collapses to the layer thickness; at 5 degrees it is an
 * order of magnitude longer, and at 0 degrees it stays finite instead of
 * blowing up the way a flat 1/sin(theta) factor does.
 */
export function slantGaseousAttenuation(
  freqGHz: number,
  elevationDeg: number,
  surface: SurfaceConditions = ISA_SURFACE,
  options: { topAltM?: number; layerCount?: number; co2Ppm?: number } = {},
): SlantGaseousResult {
  const topAltM = options.topAltM ?? 40_000;
  const layerCount = options.layerCount ?? 200;

  const layers = layerAltitudes(surface.altM, topAltM, layerCount);
  const r0 = EARTH_MEAN_RADIUS + surface.altM;
  const theta0 = Math.max(0, elevationDeg) * DEG;

  const surfaceAir = profileAt(surface.altM, surface);
  const n0 = refractivity({
    pressureHpa: surfaceAir.pressureHpa,
    temperatureK: surfaceAir.temperatureK,
    waterVapourDensity: surfaceAir.waterVapourDensity,
    ...(options.co2Ppm !== undefined ? { co2Ppm: options.co2Ppm } : {}),
  }).refractiveIndex;
  const bouguer = n0 * r0 * Math.cos(theta0);

  let oxygenDb = 0;
  let waterVapourDb = 0;
  let pathLengthM = 0;

  for (const layer of layers) {
    const air = profileAt(layer.midAltM, surface);
    const n = refractivity({
      pressureHpa: air.pressureHpa,
      temperatureK: air.temperatureK,
      waterVapourDensity: air.waterVapourDensity,
      ...(options.co2Ppm !== undefined ? { co2Ppm: options.co2Ppm } : {}),
    }).refractiveIndex;

    const r = EARTH_MEAN_RADIUS + layer.midAltM;
    const cosTheta = bouguer / (n * r);
    const sinTheta = Math.sqrt(Math.max(1e-6, 1 - cosTheta * cosTheta));
    const dsM = layer.thicknessM / sinTheta;

    const gammaO = oxygenSpecificAttenuation(freqGHz, air.pressureHpa, air.temperatureK);
    const gammaW = waterVapourSpecificAttenuation(
      freqGHz,
      air.pressureHpa,
      air.temperatureK,
      air.waterVapourDensity,
    );

    oxygenDb += (gammaO * dsM) / 1000;
    waterVapourDb += (gammaW * dsM) / 1000;
    pathLengthM += dsM;
  }

  return {
    totalDb: oxygenDb + waterVapourDb,
    oxygenDb,
    waterVapourDb,
    pathLengthM,
  };
}

/**
 * Gaseous attenuation for a terrestrial path, dB.
 *
 * Evaluated at the mean of the two terminal heights. Over a horizontal link
 * the profile barely varies, so a single specific attenuation times the path
 * length is the right level of effort -- and it keeps this cheap enough to
 * call per heatmap pixel.
 */
export function terrestrialGaseousAttenuation(
  freqGHz: number,
  distanceM: number,
  txHeightM: number,
  rxHeightM: number,
  surface: SurfaceConditions = ISA_SURFACE,
): number {
  const midAlt = surface.altM + (txHeightM + rxHeightM) / 2;
  const air = profileAt(midAlt, surface);
  const gamma = gaseousSpecificAttenuation(
    freqGHz,
    air.pressureHpa,
    air.temperatureK,
    air.waterVapourDensity,
  );
  return (gamma * distanceM) / 1000;
}
