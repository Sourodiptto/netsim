/**
 * Cloud and fog attenuation: ITU-R P.840.
 *
 * Cloud droplets are small compared with a centimetre wavelength, so Rayleigh
 * scattering applies and the attenuation is directly proportional to the
 * liquid water content. The frequency and temperature dependence all sits in
 * the dielectric constant of water, which P.840 models as a double-Debye
 * relaxation.
 *
 * Smaller than rain but not ignorable: a few tenths of a decibel at Ku band,
 * approaching a decibel at Ka, and unlike rain it is present far more of the
 * time -- so it eats margin in the availability budget rather than in the
 * worst-case one.
 */

export interface WaterDielectric {
  /** Real part of the relative permittivity. */
  epsilonReal: number;
  /** Imaginary part (the loss term). */
  epsilonImag: number;
}

/**
 * Complex permittivity of liquid water, P.840-8 double-Debye model.
 *
 * Valid to about 1000 GHz, and for supercooled droplets down to -20 degC,
 * which is why it works for high clouds and not just fog.
 */
export function waterDielectric(freqGHz: number, temperatureK: number): WaterDielectric {
  const theta = 300 / temperatureK;

  const eps0 = 77.66 + 103.3 * (theta - 1);
  const eps1 = 0.0671 * eps0;
  const eps2 = 3.52;

  // Principal and secondary relaxation frequencies, GHz.
  const fp = 20.2 - 146 * (theta - 1) + 316 * (theta - 1) ** 2;
  const fs = 39.8 * fp;

  const f = freqGHz;
  const epsilonReal =
    (eps0 - eps1) / (1 + (f / fp) ** 2) + (eps1 - eps2) / (1 + (f / fs) ** 2) + eps2;
  const epsilonImag =
    (f * (eps0 - eps1)) / (fp * (1 + (f / fp) ** 2)) +
    (f * (eps1 - eps2)) / (fs * (1 + (f / fs) ** 2));

  return { epsilonReal, epsilonImag };
}

/**
 * Cloud specific attenuation coefficient, (dB/km)/(g/m3), P.840-8 eq. 2.
 *
 * Multiply by the liquid water density to get dB/km. Separating the two is
 * useful because the coefficient depends only on frequency and temperature,
 * so it can be cached across a whole heatmap while the water content varies
 * per pixel.
 */
export function cloudAttenuationCoefficient(freqGHz: number, temperatureK: number): number {
  const { epsilonReal, epsilonImag } = waterDielectric(freqGHz, temperatureK);
  const eta = (2 + epsilonReal) / epsilonImag;
  return (0.819 * freqGHz) / (epsilonImag * (1 + eta * eta));
}

/** Cloud specific attenuation, dB/km. */
export function cloudSpecificAttenuation(
  freqGHz: number,
  temperatureK: number,
  liquidWaterDensity: number,
): number {
  if (liquidWaterDensity <= 0) return 0;
  return cloudAttenuationCoefficient(freqGHz, temperatureK) * liquidWaterDensity;
}

/**
 * Slant-path cloud attenuation from columnar liquid water, dB.
 *
 * P.840 works from the total columnar content L in kg/m2 rather than a
 * profile, because the vertical distribution of cloud water is not something
 * a link budget can know. The 1/sin(theta) factor is the plain one here: the
 * recommendation states it for elevations of 5 degrees and up, and below that
 * cloud is the least of the problems on the path.
 */
export function slantCloudAttenuation(
  freqGHz: number,
  elevationDeg: number,
  columnarLiquidWaterKgM2: number,
  cloudTemperatureK = 273.15,
): number {
  if (columnarLiquidWaterKgM2 <= 0) return 0;
  const el = Math.max(5, elevationDeg);
  const kl = cloudAttenuationCoefficient(freqGHz, cloudTemperatureK);
  return (columnarLiquidWaterKgM2 * kl) / Math.sin((el * Math.PI) / 180);
}
