/**
 * Humidity unit conversions.
 *
 * "Air PPM" is ambiguous until you pin the species. In an RF simulator the
 * part-per-million figure that changes the answer is water vapour: it drives
 * the 22.235 GHz absorption line, it dominates the wet term of radio
 * refractivity, and it is the quantity a sounding actually reports. So the
 * simulator treats water-vapour ppmv as a first-class input and converts it
 * to the vapour density that ITU-R P.676 and P.453 want.
 *
 * CO2 ppm is carried separately. Its honest effect at our bands is a very
 * small shift in dry-air refractivity -- there is no CO2 absorption line
 * below 300 GHz worth modelling -- and refractivity.ts applies it as such
 * rather than pretending it attenuates the signal.
 */

/**
 * Saturation vapour pressure over liquid water, hPa (Buck 1996).
 *
 * Buck rather than Magnus because it holds its accuracy below freezing, which
 * matters for high-altitude and winter scenarios.
 */
export function saturationVapourPressure(temperatureK: number): number {
  const tC = temperatureK - 273.15;
  return 6.1121 * Math.exp(((18.678 - tC / 234.5) * tC) / (257.14 + tC));
}

/** Partial pressure of water vapour from relative humidity, hPa. */
export function vapourPressureFromRh(relativeHumidityPct: number, temperatureK: number): number {
  const rh = Math.max(0, Math.min(100, relativeHumidityPct));
  return (rh / 100) * saturationVapourPressure(temperatureK);
}

/**
 * Water vapour density from partial pressure, g/m3.
 *
 * rho = 216.7 * e / T, the standard ITU-R form (P.453 eq. 8), which is just
 * the ideal gas law with the water-vapour gas constant folded in.
 */
export function vapourDensityFromPressure(vapourPressureHpa: number, temperatureK: number): number {
  return (216.7 * vapourPressureHpa) / temperatureK;
}

/** Water vapour partial pressure from density, hPa. The inverse of the above. */
export function vapourPressureFromDensity(
  waterVapourDensity: number,
  temperatureK: number,
): number {
  return (waterVapourDensity * temperatureK) / 216.7;
}

/** Relative humidity from vapour density, percent. */
export function rhFromVapourDensity(
  waterVapourDensity: number,
  temperatureK: number,
): number {
  const e = vapourPressureFromDensity(waterVapourDensity, temperatureK);
  return (100 * e) / saturationVapourPressure(temperatureK);
}

/**
 * Water vapour volume mixing ratio, ppm.
 *
 * A volume mixing ratio, not a mass one: ppmv = 1e6 * e / p_total. Typical
 * values run from a few hundred ppm in cold dry air to over 30 000 ppm in
 * humid tropical air, so this is a parameter with real dynamic range.
 */
export function vapourPpmv(vapourPressureHpa: number, totalPressureHpa: number): number {
  if (totalPressureHpa <= 0) return 0;
  return (1e6 * vapourPressureHpa) / totalPressureHpa;
}

/** Water vapour density from a ppmv reading, g/m3. */
export function vapourDensityFromPpmv(
  ppmv: number,
  totalPressureHpa: number,
  temperatureK: number,
): number {
  const e = (ppmv / 1e6) * totalPressureHpa;
  return vapourDensityFromPressure(e, temperatureK);
}

/** Water vapour density to ppmv, g/m3 to ppm. */
export function vapourDensityToPpmv(
  waterVapourDensity: number,
  totalPressureHpa: number,
  temperatureK: number,
): number {
  const e = vapourPressureFromDensity(waterVapourDensity, temperatureK);
  return vapourPpmv(e, totalPressureHpa);
}

/**
 * Highest vapour density the air can hold at this temperature, g/m3.
 *
 * The UI clamps to this: letting a user dial 40 g/m3 at 0 degrees C would be
 * supersaturated air, which is not a weather condition, it is a bug.
 */
export function saturationVapourDensity(temperatureK: number): number {
  return vapourDensityFromPressure(saturationVapourPressure(temperatureK), temperatureK);
}
