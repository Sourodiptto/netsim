/**
 * Propagation and antenna validation.
 *
 * Single-point anchors with published values: FSPL at 1 km, the 6 dB grazing
 * knife-edge loss, the -3 dB half-power beamwidth. Plus the structural
 * invariants that matter more than any single number -- no model may predict
 * less loss than free space, and loss must increase with distance.
 */

import { describe, expect, it } from 'vitest';
import {
  diffractionParameter,
  freeSpacePathLoss,
  fresnelRadius,
  knifeEdgeLoss,
  wavelengthMhz,
} from '../prop/fspl';
import { buildProfile, effectiveAntennaHeight, flatTerrain, fresnelClearance } from '../prop/profile';
import {
  bullingtonDiffraction,
  deygoutDiffraction,
  diffractionLoss,
  epsteinPetersonDiffraction,
} from '../prop/diffraction';
import { cost231Hata, okumuraHata, spmDefaults, standardPropagationModel } from '../prop/empirical';
import { CLUTTER, indoorLoss } from '../prop/clutter';
import {
  MACRO_PANEL,
  azimuthPattern,
  recommendedDowntilt,
  sectorAzimuths,
  sectorGain,
} from '../antenna/pattern';
import type { Geodetic } from '../core/types';

describe('free space', () => {
  it('matches the textbook value at 1 km and 1800 MHz', () => {
    expect(freeSpacePathLoss(1000, 1800)).toBeCloseTo(97.55, 1);
  });

  it('adds 6 dB per doubling of distance', () => {
    const near = freeSpacePathLoss(1000, 2100);
    const far = freeSpacePathLoss(2000, 2100);
    expect(far - near).toBeCloseTo(6.02, 2);
  });

  it('adds 6 dB per doubling of frequency', () => {
    const low = freeSpacePathLoss(5000, 900);
    const high = freeSpacePathLoss(5000, 1800);
    expect(high - low).toBeCloseTo(6.02, 2);
  });

  it('gives the expected wavelength at 1800 MHz', () => {
    expect(wavelengthMhz(1800)).toBeCloseTo(0.1666, 3);
  });
});

describe('Fresnel geometry', () => {
  it('peaks the first Fresnel radius at the path midpoint', () => {
    const atMid = fresnelRadius(5000, 5000, 1800);
    const offCentre = fresnelRadius(2000, 8000, 1800);
    expect(atMid).toBeGreaterThan(offCentre);
    expect(atMid).toBeCloseTo(20.4, 0);
  });

  it('gives zero radius at the terminals', () => {
    expect(fresnelRadius(0, 10_000, 1800)).toBe(0);
  });

  it('shrinks with frequency', () => {
    expect(fresnelRadius(5000, 5000, 3500)).toBeLessThan(fresnelRadius(5000, 5000, 900));
  });
});

describe('knife-edge diffraction', () => {
  it('gives 6 dB at grazing incidence', () => {
    expect(knifeEdgeLoss(0)).toBeCloseTo(6.02, 1);
  });

  it('gives no loss for a deeply cleared path', () => {
    expect(knifeEdgeLoss(-1.5)).toBe(0);
  });

  it('increases monotonically with the diffraction parameter', () => {
    let previous = -1;
    for (let nu = 0; nu <= 5; nu += 0.25) {
      const loss = knifeEdgeLoss(nu);
      expect(loss).toBeGreaterThan(previous);
      previous = loss;
    }
  });

  it('signs the diffraction parameter positive for a blocking obstruction', () => {
    expect(diffractionParameter(50, 5000, 5000, 1800)).toBeGreaterThan(0);
    expect(diffractionParameter(-50, 5000, 5000, 1800)).toBeLessThan(0);
  });
});

describe('terrain profiles', () => {
  const mumbai: Geodetic = { latDeg: 19.076, lonDeg: 72.8777, altM: 0 };
  const pune: Geodetic = { latDeg: 18.5204, lonDeg: 73.8567, altM: 0 };

  it('samples a profile between two points with the endpoints included', () => {
    const profile = buildProfile(mumbai, pune, flatTerrain, 32);
    expect(profile.distancesM).toHaveLength(32);
    expect(profile.distancesM[0]).toBe(0);
    expect(profile.distancesM[31]).toBeCloseTo(profile.distanceM, 6);
  });

  it('adds Earth bulge peaking at the path midpoint', () => {
    const profile = buildProfile(mumbai, pune, flatTerrain, 33);
    const mid = profile.effectiveM[16]!;
    const nearEnd = profile.effectiveM[1]!;
    expect(mid).toBeGreaterThan(nearEnd);
    // Over ~120 km the k=4/3 bulge at midpoint is a few hundred metres.
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(600);
  });

  it('raises the bulge when the refractivity gradient flattens', () => {
    const standard = buildProfile(mumbai, pune, flatTerrain, 33, -39);
    const flat = buildProfile(mumbai, pune, flatTerrain, 33, 0);
    expect(flat.effectiveM[16]!).toBeGreaterThan(standard.effectiveM[16]!);
  });

  it('measures effective antenna height above the surrounding terrain', () => {
    const plateau = () => 600;
    const profile = buildProfile(mumbai, pune, plateau, 32);
    for (const method of ['spot', 'mean-terrain', 'least-squares'] as const) {
      expect(effectiveAntennaHeight(profile, 640, method)).toBeCloseTo(40, 0);
    }
  });

  it('floors effective antenna height at 1 m for a mast in a valley', () => {
    const highGround = () => 1000;
    const profile = buildProfile(mumbai, pune, highGround, 32);
    expect(effectiveAntennaHeight(profile, 500, 'mean-terrain')).toBe(1);
  });

  it('only spot height is immune to double-counting a downrange ridge', () => {
    // A mast on flat ground with a 400 m ridge halfway down the path. The
    // ridge lifts both the mean and the fitted intercept, so mean-terrain and
    // least-squares both charge for ground the diffraction term is already
    // accounting for. spot does not. This is the trap documented on the
    // function, asserted so it cannot be quietly "fixed" the wrong way.
    const ridge = (latDeg: number): number => {
      const d = Math.abs(latDeg - 18.8) / 0.02;
      return d >= 1 ? 0 : 400 * (1 - d * d);
    };
    const profile = buildProfile(mumbai, pune, ridge, 256);
    const antennaAltM = 40;

    const spot = effectiveAntennaHeight(profile, antennaAltM, 'spot');
    const mean = effectiveAntennaHeight(profile, antennaAltM, 'mean-terrain');
    const fitted = effectiveAntennaHeight(profile, antennaAltM, 'least-squares');

    expect(spot).toBeCloseTo(40, 0);
    expect(mean).toBeLessThan(spot);
    // A mid-path peak moves the fit and the mean by nearly the same amount.
    expect(Math.abs(fitted - mean)).toBeLessThan(5);
  });

  it('gives least-squares the most leverage to a peak near a terminal', () => {
    // The counter-intuitive one, pinned so nobody "optimises" it away. The
    // intercept is an extrapolation to the path end, and in a linear fit the
    // extreme points dominate it. A 500 m ridge near the far terminal tilts
    // the line and pushes the intercept *below* the real ground, inflating
    // h_eff rather than deflating it -- an error in the opposite direction
    // from the mean's, and a larger one.
    const farRidge = (latDeg: number): number => {
      const d = Math.abs(latDeg - 18.56) / 0.03;
      return d >= 1 ? 0 : 500 * (1 - d * d);
    };
    const profile = buildProfile(mumbai, pune, farRidge, 256);
    const antennaAltM = 40;

    const spot = effectiveAntennaHeight(profile, antennaAltM, 'spot');
    const mean = effectiveAntennaHeight(profile, antennaAltM, 'mean-terrain');
    const fitted = effectiveAntennaHeight(profile, antennaAltM, 'least-squares');

    // The mean under-reads, the fit over-reads, and the fit errs further.
    expect(mean).toBeLessThan(spot);
    expect(fitted).toBeGreaterThan(spot);
    expect(Math.abs(fitted - spot)).toBeGreaterThan(Math.abs(mean - spot));
  });

  it('tracks a consistent terrain slope with the least-squares datum', () => {
    // Ground rising steadily along the path: the fit should recover the level
    // under the transmitter, not the average over the whole path. Tolerance
    // is metres rather than centimetres because latitude is only
    // near-linear in great-circle distance.
    const slope = (latDeg: number): number => (latDeg - 19.076) * -20_000;
    const profile = buildProfile(mumbai, pune, slope, 128);
    const atTx = profile.groundM[0]!;
    const fitted = effectiveAntennaHeight(profile, atTx + 50, 'least-squares');
    const mean = effectiveAntennaHeight(profile, atTx + 50, 'mean-terrain');

    expect(Math.abs(fitted - 50)).toBeLessThan(15);
    // The mean is dragged by the whole rising path and loses far more.
    expect(Math.abs(mean - 50)).toBeGreaterThan(Math.abs(fitted - 50));
  });

  it('reports full Fresnel clearance for a high path over flat ground', () => {
    const profile = buildProfile(
      { latDeg: 19.0, lonDeg: 72.9, altM: 0 },
      { latDeg: 19.05, lonDeg: 72.9, altM: 0 },
      flatTerrain,
      64,
    );
    expect(fresnelClearance(profile, 2000, 2000, 1800)).toBeGreaterThan(1);
  });
});

describe('terrain diffraction constructions', () => {
  const from: Geodetic = { latDeg: 19.0, lonDeg: 72.9, altM: 0 };
  const to: Geodetic = { latDeg: 19.18, lonDeg: 72.9, altM: 0 };

  /** A single ridge at the path midpoint, rising to peakM. */
  const ridge = (peakM: number) => (latDeg: number): number => {
    const centre = 19.09;
    const width = 0.02;
    const d = Math.abs(latDeg - centre) / width;
    return d >= 1 ? 0 : peakM * (1 - d * d);
  };

  it('reports no diffraction loss for a clear high path', () => {
    const profile = buildProfile(from, to, flatTerrain, 64);
    for (const method of ['bullington', 'deygout', 'epstein-peterson'] as const) {
      const result = diffractionLoss(method, profile, 3000, 3000, 1800);
      expect(result.lossDb).toBe(0);
      expect(result.lineOfSight).toBe(true);
    }
  });

  it('reports substantial loss for a blocked path', () => {
    const profile = buildProfile(from, to, ridge(900), 128);
    const result = bullingtonDiffraction(profile, 40, 1.5, 1800);
    expect(result.lineOfSight).toBe(false);
    expect(result.lossDb).toBeGreaterThan(15);
  });

  it('increases loss as the obstruction grows', () => {
    let previous = -1;
    for (const peak of [0, 100, 300, 600, 900]) {
      const profile = buildProfile(from, to, ridge(peak), 128);
      const loss = bullingtonDiffraction(profile, 40, 1.5, 1800).lossDb;
      expect(loss).toBeGreaterThanOrEqual(previous);
      previous = loss;
    }
    expect(previous).toBeGreaterThan(20);
  });

  it('places the dominant edge near the ridge', () => {
    const profile = buildProfile(from, to, ridge(600), 128);
    const result = deygoutDiffraction(profile, 40, 1.5, 1800);
    const fraction = result.dominantDistanceM / profile.distanceM;
    expect(fraction).toBeGreaterThan(0.3);
    expect(fraction).toBeLessThan(0.7);
  });

  it('damps the secondary edges when Causebrook is enabled', () => {
    const profile = buildProfile(from, to, ridge(600), 128);
    const plain = deygoutDiffraction(profile, 40, 1.5, 1800, { causebrook: false }).lossDb;
    const damped = deygoutDiffraction(profile, 40, 1.5, 1800, { causebrook: true }).lossDb;
    expect(damped).toBeLessThanOrEqual(plain);
  });

  it('agrees across constructions within a reasonable spread', () => {
    const profile = buildProfile(from, to, ridge(500), 128);
    const b = bullingtonDiffraction(profile, 40, 1.5, 1800).lossDb;
    const d = deygoutDiffraction(profile, 40, 1.5, 1800).lossDb;
    const e = epsteinPetersonDiffraction(profile, 40, 1.5, 1800).lossDb;

    const values = [b, d, e].filter((v) => v > 0);
    expect(values.length).toBeGreaterThan(0);
    const spread = Math.max(...values) - Math.min(...values);
    // Constructions genuinely disagree; the point is that they disagree by
    // decibels rather than orders of magnitude.
    expect(spread).toBeLessThan(25);
  });

  it('loses more at higher frequency over the same ridge', () => {
    const profile = buildProfile(from, to, ridge(400), 128);
    const low = bullingtonDiffraction(profile, 40, 1.5, 700).lossDb;
    const high = bullingtonDiffraction(profile, 40, 1.5, 3500).lossDb;
    expect(high).toBeGreaterThan(low);
  });
});

describe('empirical path loss models', () => {
  it('matches a hand-computed Okumura-Hata urban case', () => {
    // 900 MHz, 5 km, 50 m base, 1.5 m mobile.
    const result = okumuraHata({
      freqMhz: 900,
      distanceM: 5000,
      baseHeightM: 50,
      mobileHeightM: 1.5,
    });
    expect(result.inRange).toBe(true);
    expect(result.lossDb).toBeGreaterThan(140);
    expect(result.lossDb).toBeLessThan(160);
  });

  it('orders Hata environments correctly', () => {
    const base = { freqMhz: 900, distanceM: 5000, baseHeightM: 50, mobileHeightM: 1.5 };
    const urban = okumuraHata({ ...base, environment: 'urban' }).lossDb;
    const suburban = okumuraHata({ ...base, environment: 'suburban' }).lossDb;
    const open = okumuraHata({ ...base, environment: 'open' }).lossDb;
    expect(urban).toBeGreaterThan(suburban);
    expect(suburban).toBeGreaterThan(open);
  });

  it('flags out-of-range inputs instead of extrapolating silently', () => {
    const tooHigh = okumuraHata({
      freqMhz: 3500,
      distanceM: 5000,
      baseHeightM: 50,
      mobileHeightM: 1.5,
    });
    expect(tooHigh.inRange).toBe(false);
    expect(tooHigh.warnings.join(' ')).toContain('frequency');
  });

  it('adds the 3 dB metropolitan correction in COST-231', () => {
    const base = { freqMhz: 1800, distanceM: 5000, baseHeightM: 40, mobileHeightM: 1.5 };
    const medium = cost231Hata(base).lossDb;
    const metro = cost231Hata({ ...base, metropolitan: true }).lossDb;
    expect(metro - medium).toBeCloseTo(3, 6);
  });

  it('increases loss with distance and decreases it with mast height', () => {
    const base = { freqMhz: 1800, baseHeightM: 40, mobileHeightM: 1.5 };
    expect(cost231Hata({ ...base, distanceM: 10_000 }).lossDb).toBeGreaterThan(
      cost231Hata({ ...base, distanceM: 2_000 }).lossDb,
    );
    expect(cost231Hata({ ...base, distanceM: 5000, baseHeightM: 80 }).lossDb).toBeLessThan(
      cost231Hata({ ...base, distanceM: 5000, baseHeightM: 20 }).lossDb,
    );
  });

  it('calibrates SPM to agree with COST-231 at the reference geometry', () => {
    const freqMhz = 1800;
    const reference = cost231Hata({
      freqMhz,
      distanceM: 1000,
      baseHeightM: 30,
      mobileHeightM: 1.5,
    }).lossDb;

    const spm = standardPropagationModel({
      freqMhz,
      distanceM: 1000,
      txHeightEffM: 30,
      rxHeightM: 1.5,
      diffractionLossDb: 0,
      clutter: 'urban',
      coefficients: spmDefaults(freqMhz),
    });

    expect(spm.lossDb).toBeCloseTo(reference, 1);
  });

  it('never predicts less loss than free space', () => {
    for (const distanceM of [200, 500, 1000, 5000, 20_000]) {
      for (const freqMhz of [700, 900, 1800, 2100, 3500]) {
        const spm = standardPropagationModel({
          freqMhz,
          distanceM,
          txHeightEffM: 30,
          rxHeightM: 1.5,
          diffractionLossDb: 0,
          clutter: 'rural',
        });
        expect(spm.lossDb).toBeGreaterThanOrEqual(freeSpacePathLoss(distanceM, freqMhz) - 1e-9);
      }
    }
  });

  it('passes diffraction loss through with the K4 weight', () => {
    const common = {
      freqMhz: 1800,
      distanceM: 8000,
      txHeightEffM: 30,
      rxHeightM: 1.5,
      clutter: 'rural' as const,
    };
    const clear = standardPropagationModel({ ...common, diffractionLossDb: 0 }).lossDb;
    const blocked = standardPropagationModel({ ...common, diffractionLossDb: 20 }).lossDb;
    const coefficients = spmDefaults(1800);
    expect(blocked - clear).toBeCloseTo(20 * coefficients.k4, 6);
  });

  it('orders clutter classes by loss', () => {
    expect(CLUTTER['dense-urban'].lossDb).toBeGreaterThan(CLUTTER.urban.lossDb);
    expect(CLUTTER.urban.lossDb).toBeGreaterThan(CLUTTER.suburban.lossDb);
    expect(CLUTTER.suburban.lossDb).toBeGreaterThan(CLUTTER.rural.lossDb);
    expect(CLUTTER.water.lossDb).toBeLessThan(CLUTTER.rural.lossDb);
  });

  it('raises indoor penetration loss with frequency', () => {
    expect(indoorLoss('urban', 3500)).toBeGreaterThan(indoorLoss('urban', 900));
    expect(indoorLoss('water', 1800)).toBe(0);
  });
});

describe('antenna patterns', () => {
  it('gives exactly -3 dB at the half-power beamwidth edge', () => {
    expect(azimuthPattern(32.5, 65, 30)).toBeCloseTo(-3, 6);
  });

  it('gives full gain on boresight', () => {
    const gain = sectorGain(MACRO_PANEL, { azimuthDeg: 120, downtiltDeg: 0 }, 120, 0);
    expect(gain).toBeCloseTo(MACRO_PANEL.maxGainDbi, 6);
  });

  it('clips at the side-lobe floor behind the antenna', () => {
    const gain = sectorGain(MACRO_PANEL, { azimuthDeg: 0, downtiltDeg: 0 }, 180, 0);
    expect(gain).toBeCloseTo(MACRO_PANEL.maxGainDbi - MACRO_PANEL.floorDb, 6);
  });

  it('steers the vertical main lobe below the horizon when tilted down', () => {
    const tilt = 6;
    const orientation = { azimuthDeg: 0, downtiltDeg: tilt };
    const atHorizon = sectorGain(MACRO_PANEL, orientation, 0, 0);
    const atBoresight = sectorGain(MACRO_PANEL, orientation, 0, -tilt);
    expect(atBoresight).toBeGreaterThan(atHorizon);
    expect(atBoresight).toBeCloseTo(MACRO_PANEL.maxGainDbi, 6);
  });

  it('treats an omni as flat in azimuth', () => {
    expect(azimuthPattern(0, 360, 10)).toBe(0);
    expect(azimuthPattern(170, 360, 10)).toBe(0);
  });

  it('lays out three sectors 120 degrees apart', () => {
    expect(sectorAzimuths(3)).toEqual([0, 120, 240]);
    expect(sectorAzimuths(3, 30)).toEqual([30, 150, 270]);
    expect(sectorAzimuths(1, 45)).toEqual([45]);
  });

  it('recommends more downtilt for a shorter cell', () => {
    const tight = recommendedDowntilt(30, 500, 7);
    const wide = recommendedDowntilt(30, 3000, 7);
    expect(tight).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(3.5);
  });
});
