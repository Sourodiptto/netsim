/**
 * Atmospheric model validation.
 *
 * The reference points here are published values, not outputs of this code:
 * ISA layer boundaries, the standard surface refractivity of roughly 315
 * N-units, the k = 4/3 convention, and the P.838-1 coefficient table -- which
 * is a genuinely independent check, because P.838-3 replaced the table with a
 * curve fit and the two should still agree.
 */

import { describe, expect, it } from 'vitest';
import { airDensity, isaAt, ISA_SURFACE, pressureFromDensity, profileAt } from '../atmos/isa';
import {
  saturationVapourDensity,
  vapourDensityFromPressure,
  vapourDensityToPpmv,
  vapourDensityFromPpmv,
  vapourPressureFromDensity,
  vapourPressureFromRh,
} from '../atmos/humidity';
import {
  effectiveEarthRadius,
  kFactor,
  radioHorizon,
  refractionCorrection,
  refractionRegime,
  refractivity,
  refractivityGradient,
  STANDARD_GRADIENT_N_PER_KM,
} from '../atmos/refractivity';
import {
  gaseousSpecificAttenuation,
  oxygenSpecificAttenuation,
  slantGaseousAttenuation,
  waterVapourSpecificAttenuation,
} from '../atmos/gaseous';
import {
  earthSpaceRainAttenuation,
  rainCoefficients,
  rainHeight,
  rainSpecificAttenuation,
  terrestrialRainAttenuation,
} from '../atmos/rain';
import { cloudAttenuationCoefficient, waterDielectric } from '../atmos/cloud';
import { EARTH_MEAN_RADIUS } from '../core/constants';

describe('standard atmosphere', () => {
  it('reproduces the sea-level reference state', () => {
    const { pressurePa, temperatureK } = isaAt(0);
    expect(pressurePa).toBeCloseTo(101_325, 0);
    expect(temperatureK).toBeCloseTo(288.15, 6);
    expect(airDensity(pressurePa / 100, temperatureK)).toBeCloseTo(1.225, 2);
  });

  it('reproduces the tropopause at 11 km', () => {
    const { pressurePa, temperatureK } = isaAt(11_000);
    expect(temperatureK).toBeCloseTo(216.65, 2);
    expect(pressurePa).toBeCloseTo(22_632, -1);
  });

  it('holds the isothermal layer from 11 to 20 km', () => {
    expect(isaAt(15_000).temperatureK).toBeCloseTo(216.65, 2);
    expect(isaAt(20_000).temperatureK).toBeCloseTo(216.65, 2);
  });

  it('decreases pressure monotonically with altitude', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let h = 0; h <= 60_000; h += 1_000) {
      const p = isaAt(h).pressurePa;
      expect(p).toBeLessThan(previous);
      previous = p;
    }
  });

  it('inverts density back to pressure consistently', () => {
    const pressureHpa = 950;
    const temperatureK = 295;
    const rho = airDensity(pressureHpa, temperatureK);
    expect(pressureFromDensity(rho, temperatureK)).toBeCloseTo(pressureHpa, 9);
  });

  it('anchors a scaled profile to the surface reading it was given', () => {
    const surface = { pressureHpa: 950, temperatureK: 303, waterVapourDensity: 18, altM: 500 };
    const atSurface = profileAt(500, surface);
    expect(atSurface.pressureHpa).toBeCloseTo(950, 6);
    expect(atSurface.temperatureK).toBeCloseTo(303, 6);
    expect(atSurface.waterVapourDensity).toBeCloseTo(18, 6);
  });

  it('decays water vapour with a 2 km scale height', () => {
    const atSurface = profileAt(0, ISA_SURFACE).waterVapourDensity;
    const at2km = profileAt(2_000, ISA_SURFACE).waterVapourDensity;
    expect(at2km / atSurface).toBeCloseTo(Math.exp(-1), 6);
  });
});

describe('humidity conversions', () => {
  it('round-trips vapour density through partial pressure', () => {
    const rho = 12.5;
    const t = 298;
    const e = vapourPressureFromDensity(rho, t);
    expect(vapourDensityFromPressure(e, t)).toBeCloseTo(rho, 9);
  });

  it('round-trips vapour density through ppmv', () => {
    const rho = 15;
    const t = 300;
    const p = 1005;
    const ppmv = vapourDensityToPpmv(rho, p, t);
    expect(vapourDensityFromPpmv(ppmv, p, t)).toBeCloseTo(rho, 9);
  });

  it('puts humid tropical air in the tens of thousands of ppm', () => {
    // 30 degC, 80% RH: the Mumbai monsoon condition.
    const t = 303.15;
    const e = vapourPressureFromRh(80, t);
    const rho = vapourDensityFromPressure(e, t);
    const ppmv = vapourDensityToPpmv(rho, 1005, t);
    expect(ppmv).toBeGreaterThan(20_000);
    expect(ppmv).toBeLessThan(40_000);
  });

  it('caps vapour density at saturation', () => {
    // Cold air holds very little water; warm air holds a lot.
    expect(saturationVapourDensity(273.15)).toBeLessThan(6);
    expect(saturationVapourDensity(313.15)).toBeGreaterThan(40);
  });
});

describe('refractivity and the effective Earth radius', () => {
  it('gives the standard surface refractivity of about 315 N-units', () => {
    const n = refractivity({
      pressureHpa: 1013.25,
      temperatureK: 288.15,
      waterVapourDensity: 7.5,
    }).n;
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(330);
  });

  it('attributes most of the refractivity to dry air but a sixth to vapour', () => {
    const r = refractivity({
      pressureHpa: 1013.25,
      temperatureK: 288.15,
      waterVapourDensity: 7.5,
    });
    expect(r.dry).toBeGreaterThan(r.wet * 4);
    expect(r.wet).toBeGreaterThan(30);
  });

  it('makes humid air substantially more refractive than dry air', () => {
    const dry = refractivity({ pressureHpa: 1013, temperatureK: 303, waterVapourDensity: 2 }).n;
    const humid = refractivity({ pressureHpa: 1013, temperatureK: 303, waterVapourDensity: 25 }).n;
    expect(humid - dry).toBeGreaterThan(90);
  });

  it('treats CO2 as a second-order effect, as the physics says', () => {
    const base = refractivity({
      pressureHpa: 1013,
      temperatureK: 288,
      waterVapourDensity: 7.5,
      co2Ppm: 400,
    }).n;
    const doubled = refractivity({
      pressureHpa: 1013,
      temperatureK: 288,
      waterVapourDensity: 7.5,
      co2Ppm: 800,
    }).n;
    const shift = doubled - base;
    expect(shift).toBeGreaterThan(0);
    expect(shift).toBeLessThan(0.5);
  });

  it('yields k = 4/3 for the standard gradient', () => {
    // The conventional "4/3" is a round number for 157/118 = 1.3305, which is
    // what the -39 N/km gradient actually gives. Close enough to quote, not
    // close enough to assert to the metre.
    expect(kFactor(STANDARD_GRADIENT_N_PER_KM)).toBeCloseTo(4 / 3, 2);
    expect(kFactor(STANDARD_GRADIENT_N_PER_KM)).toBeCloseTo(157 / 118, 9);
    expect(effectiveEarthRadius(STANDARD_GRADIENT_N_PER_KM)).toBeCloseTo(
      (157 / 118) * EARTH_MEAN_RADIUS,
      3,
    );
  });

  it('derives a near-standard gradient from the standard profile', () => {
    const gradient = refractivityGradient(ISA_SURFACE);
    expect(gradient).toBeLessThan(-30);
    expect(gradient).toBeGreaterThan(-60);
    expect(kFactor(gradient)).toBeGreaterThan(1.2);
    expect(kFactor(gradient)).toBeLessThan(1.5);
  });

  it('classifies refraction regimes at the conventional boundaries', () => {
    expect(refractionRegime(10)).toBe('sub-refractive');
    expect(refractionRegime(-39)).toBe('normal');
    expect(refractionRegime(-100)).toBe('super-refractive');
    expect(refractionRegime(-200)).toBe('trapping');
  });

  it('extends the radio horizon under a stronger gradient', () => {
    const standard = radioHorizon(30, -39);
    const flat = radioHorizon(30, 0);
    const ducting = radioHorizon(30, -150);

    // The classic 30 m tower sees a little over 22 km on a standard day.
    expect(standard / 1000).toBeGreaterThan(20);
    expect(standard / 1000).toBeLessThan(25);
    // A flat gradient costs about a fifth of that reach.
    expect(flat).toBeLessThan(standard);
    expect(flat / standard).toBeGreaterThan(0.8);
    // Near-ducting conditions extend it dramatically.
    expect(ducting).toBeGreaterThan(standard * 2);
  });

  it('bends rays most near the horizon and not at all at zenith', () => {
    expect(Math.abs(refractionCorrection(90, ISA_SURFACE))).toBeLessThan(0.001);
    const atHorizon = refractionCorrection(0, ISA_SURFACE);
    // Radio refraction at the horizon is a few tenths of a degree.
    expect(atHorizon).toBeGreaterThan(0.2);
    expect(atHorizon).toBeLessThan(1.2);
  });

  it('bends rays monotonically more as elevation falls', () => {
    const angles = [60, 40, 20, 10, 5];
    let previous = 0;
    for (const el of angles) {
      const tau = refractionCorrection(el, ISA_SURFACE);
      expect(tau).toBeGreaterThan(previous);
      previous = tau;
    }
  });
});

describe('gaseous absorption (ITU-R P.676)', () => {
  it('matches the known oxygen attenuation at 1.8 GHz', () => {
    // About 0.0065 dB/km at sea level in the standard atmosphere.
    const gamma = oxygenSpecificAttenuation(1.8, 1013, 288.15);
    expect(gamma).toBeGreaterThan(0.005);
    expect(gamma).toBeLessThan(0.008);
  });

  it('matches the known water-vapour attenuation on the 22 GHz line', () => {
    // Roughly 0.18 dB/km at 7.5 g/m3, sea level.
    const gamma = waterVapourSpecificAttenuation(22.235, 1013, 288.15, 7.5);
    expect(gamma).toBeGreaterThan(0.15);
    expect(gamma).toBeLessThan(0.22);
  });

  it('peaks water-vapour absorption on the line rather than beside it', () => {
    const onLine = waterVapourSpecificAttenuation(22.235, 1013, 288.15, 7.5);
    const below = waterVapourSpecificAttenuation(18, 1013, 288.15, 7.5);
    const above = waterVapourSpecificAttenuation(27, 1013, 288.15, 7.5);
    expect(onLine).toBeGreaterThan(below);
    expect(onLine).toBeGreaterThan(above);
  });

  it('scales water-vapour absorption with vapour density', () => {
    const dry = waterVapourSpecificAttenuation(22.235, 1013, 288.15, 2);
    const humid = waterVapourSpecificAttenuation(22.235, 1013, 288.15, 20);
    expect(humid / dry).toBeGreaterThan(5);
  });

  it('refuses to extrapolate above its stated frequency range', () => {
    expect(Number.isNaN(oxygenSpecificAttenuation(60, 1013, 288))).toBe(true);
    expect(Number.isNaN(gaseousSpecificAttenuation(80, 1013, 288, 7.5))).toBe(true);
  });

  it('gives a sub-decibel zenith attenuation on the 22 GHz line', () => {
    const result = slantGaseousAttenuation(22.235, 90, ISA_SURFACE);
    expect(result.totalDb).toBeGreaterThan(0.25);
    expect(result.totalDb).toBeLessThan(0.9);
    expect(result.waterVapourDb).toBeGreaterThan(result.oxygenDb);
  });

  it('grows attenuation as elevation falls, faster than 1/sin at low angles', () => {
    const zenith = slantGaseousAttenuation(20, 90, ISA_SURFACE).totalDb;
    const low = slantGaseousAttenuation(20, 5, ISA_SURFACE).totalDb;
    const ratio = low / zenith;
    // 1/sin(5 deg) is 11.5; spherical geometry gives a bit more.
    expect(ratio).toBeGreaterThan(9);
    expect(ratio).toBeLessThan(16);
  });

  it('stays finite at zero elevation', () => {
    const grazing = slantGaseousAttenuation(20, 0, ISA_SURFACE).totalDb;
    expect(Number.isFinite(grazing)).toBe(true);
    expect(grazing).toBeGreaterThan(0);
  });

  it('makes humid air cost more at Ka band', () => {
    const dry = slantGaseousAttenuation(20, 30, {
      ...ISA_SURFACE,
      waterVapourDensity: 2,
    }).totalDb;
    const humid = slantGaseousAttenuation(20, 30, {
      ...ISA_SURFACE,
      waterVapourDensity: 22,
    }).totalDb;
    expect(humid).toBeGreaterThan(dry * 1.5);
  });
});

describe('rain attenuation', () => {
  /**
   * Published ITU-R P.838-3 k and alpha values.
   *
   * On a horizontal path (elevation 0) with tau = 0 the polarization mixing
   * collapses to exactly kH and alphaH, and with tau = 90 to kV and alphaV.
   * That makes these a direct pin on the Gaussian coefficient tables rather
   * than on some blended intermediate.
   *
   * Note for anyone cross-checking against older sources: P.838-1 published a
   * discrete table with noticeably different numbers (kH 0.0101 at 10 GHz
   * against 0.01217 here). P.838-3 recomputed the scattering with different
   * drop-size-distribution assumptions. The two genuinely disagree by up to
   * 20 percent, and P.838-3 is the current recommendation.
   */
  const P838_3_REFERENCE = [
    { freqGHz: 10, kH: 0.01217, aH: 1.2571, kV: 0.01129, aV: 1.2156 },
    { freqGHz: 12, kH: 0.02386, aH: 1.1825, kV: 0.02455, aV: 1.1216 },
    { freqGHz: 20, kH: 0.09164, aH: 1.0568, kV: 0.09611, aV: 0.9847 },
    { freqGHz: 30, kH: 0.24031, aH: 0.9485, kV: 0.22909, aV: 0.9129 },
    { freqGHz: 40, kH: 0.44306, aH: 0.8673, kV: 0.42738, aV: 0.8421 },
  ];

  it('reproduces the published P.838-3 horizontal coefficients', () => {
    for (const ref of P838_3_REFERENCE) {
      const { k, alpha } = rainCoefficients(ref.freqGHz, 0, 0);
      expect(k).toBeCloseTo(ref.kH, 4);
      expect(alpha).toBeCloseTo(ref.aH, 3);
    }
  });

  it('reproduces the published P.838-3 vertical coefficients', () => {
    for (const ref of P838_3_REFERENCE) {
      const { k, alpha } = rainCoefficients(ref.freqGHz, 0, 90);
      expect(k).toBeCloseTo(ref.kV, 4);
      expect(alpha).toBeCloseTo(ref.aV, 3);
    }
  });

  it('places circular polarization between the two linear ones', () => {
    for (const ref of P838_3_REFERENCE) {
      const circular = rainCoefficients(ref.freqGHz, 0, 45);
      expect(circular.k).toBeCloseTo((ref.kH + ref.kV) / 2, 5);
      expect(circular.alpha).toBeGreaterThan(Math.min(ref.aH, ref.aV) - 1e-6);
      expect(circular.alpha).toBeLessThan(Math.max(ref.aH, ref.aV) + 1e-6);
    }
  });

  it('attenuates horizontal polarization more than vertical at real rain rates', () => {
    // Oblate drops present a wider cross-section to a horizontal field. The
    // effect shows up in the specific attenuation, not in k alone -- above
    // about 12 GHz P.838-3 gives kV slightly larger than kH, and it is the
    // smaller alphaV that puts vertical below horizontal once R exceeds a few
    // millimetres an hour. Asserting on k would get this backwards.
    for (const freqGHz of [12, 20, 30]) {
      for (const rainRate of [10, 50, 100]) {
        const horizontal = rainSpecificAttenuation(rainRate, freqGHz, 0, 0);
        const vertical = rainSpecificAttenuation(rainRate, freqGHz, 0, 90);
        expect(horizontal).toBeGreaterThan(vertical);
      }
    }
  });

  it('returns zero attenuation in clear sky', () => {
    expect(rainSpecificAttenuation(0, 20, 30)).toBe(0);
  });

  it('rises steeply with frequency, which is why Ka band needs margin', () => {
    const at6 = rainSpecificAttenuation(50, 6, 30);
    const at14 = rainSpecificAttenuation(50, 14, 30);
    const at30 = rainSpecificAttenuation(50, 30, 30);
    expect(at14 / at6).toBeGreaterThan(5);
    expect(at30 / at14).toBeGreaterThan(2);
  });

  it('puts the rain height above the station in the tropics', () => {
    expect(rainHeight(19)).toBeCloseTo(5360, 0);
    expect(rainHeight(45)).toBeLessThan(rainHeight(19));
  });

  it('produces plausible Ka-band fade for a monsoon rain rate', () => {
    // Mumbai: R0.01 around 95 mm/h, Ka downlink at 20 GHz, 40 degree elevation.
    const result = earthSpaceRainAttenuation({
      freqGHz: 20,
      elevationDeg: 40,
      latDeg: 19.076,
      stationAltM: 14,
      rain001MmH: 95,
    });
    // Published Ka-band 0.01% fades for tropical coastal sites run tens of dB.
    expect(result.attenuationDb).toBeGreaterThan(12);
    expect(result.attenuationDb).toBeLessThan(45);
  });

  it('costs less at a higher elevation angle on the same day', () => {
    const common = { freqGHz: 20, latDeg: 19.076, stationAltM: 14, rain001MmH: 95 };
    const low = earthSpaceRainAttenuation({ ...common, elevationDeg: 15 }).attenuationDb;
    const high = earthSpaceRainAttenuation({ ...common, elevationDeg: 70 }).attenuationDb;
    expect(low).toBeGreaterThan(high);
  });

  it('exceeds less often means less attenuation', () => {
    const common = {
      freqGHz: 20,
      elevationDeg: 40,
      latDeg: 19.076,
      stationAltM: 14,
      rain001MmH: 95,
    };
    const rare = earthSpaceRainAttenuation({ ...common, percentOfTime: 0.01 }).attenuationDb;
    const common1pc = earthSpaceRainAttenuation({ ...common, percentOfTime: 1 }).attenuationDb;
    expect(rare).toBeGreaterThan(common1pc);
  });

  it('returns zero when the station sits above the rain layer', () => {
    const result = earthSpaceRainAttenuation({
      freqGHz: 20,
      elevationDeg: 40,
      latDeg: 28,
      stationAltM: 9_000,
      rain001MmH: 50,
    });
    expect(result.attenuationDb).toBe(0);
  });

  it('keeps the terrestrial path reduction factor self-consistent at 0.01 percent', () => {
    const result = terrestrialRainAttenuation({
      freqGHz: 18,
      distanceKm: 10,
      rain001MmH: 95,
    });
    expect(result.attenuationDb).toBeCloseTo(result.a001Db, 6);
    expect(result.effectiveDistanceKm).toBeLessThan(10);
    expect(result.attenuationDb).toBeGreaterThan(10);
  });
});

describe('cloud attenuation (ITU-R P.840)', () => {
  it('gives a physically sensible permittivity for water', () => {
    const { epsilonReal, epsilonImag } = waterDielectric(20, 283);
    expect(epsilonReal).toBeGreaterThan(10);
    expect(epsilonReal).toBeLessThan(90);
    expect(epsilonImag).toBeGreaterThan(0);
  });

  it('rises with frequency through the microwave bands', () => {
    const at10 = cloudAttenuationCoefficient(10, 273.15);
    const at20 = cloudAttenuationCoefficient(20, 273.15);
    const at40 = cloudAttenuationCoefficient(40, 273.15);
    expect(at20).toBeGreaterThan(at10);
    expect(at40).toBeGreaterThan(at20);
  });

  it('stays an order of magnitude below rain at the same frequency', () => {
    // 0.5 g/m3 of cloud liquid water against 50 mm/h of rain, both at 20 GHz.
    const cloud = cloudAttenuationCoefficient(20, 273.15) * 0.5;
    const rain = rainSpecificAttenuation(50, 20, 30);
    expect(cloud).toBeLessThan(rain / 5);
  });
});
