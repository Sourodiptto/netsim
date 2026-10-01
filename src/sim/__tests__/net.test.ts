/**
 * Link budget, throughput and orbit validation.
 *
 * The two bugs this file exists to prevent: adding interference in the log
 * domain, and comparing a total transmit power against an RSRP threshold.
 * Both produce maps that look plausible and are wrong by tens of decibels.
 */

import { describe, expect, it } from 'vitest';
import { sumDbm } from '../core/math';
import {
  eirp,
  gOverT,
  noisePerSubcarrier,
  resourceBlockCount,
  rsrp,
  rssi,
  satelliteLink,
  sinr,
  skyNoiseTemperature,
  systemNoiseTemperature,
  thermalNoise,
} from '../net/linkbudget';
import {
  CQI_TABLE_256QAM,
  cqiThroughput,
  dvbs2xThroughput,
  shannonThroughput,
} from '../net/throughput';
import {
  circularOrbit,
  geostationaryOrbit,
  gmstDeg,
  parseTle,
  propagate,
  orbitalPeriod,
  semiMajorAxis,
  solveKepler,
} from '../orbit/elements';
import {
  bestSatellite,
  dopplerShiftHz,
  findPasses,
  footprintRadius,
  observe,
  slantRangeAtElevation,
} from '../orbit/visibility';
import { WGS84_A } from '../core/constants';

describe('noise and power arithmetic', () => {
  it('gives the standard thermal noise floor', () => {
    // -174 dBm/Hz is the kT0 reference.
    expect(thermalNoise(1, 0)).toBeCloseTo(-174, 1);
  });

  it('matches the known noise power in a 20 MHz channel', () => {
    // -174 + 10log10(20e6) + 7 = -94 dBm.
    expect(thermalNoise(20e6, 7)).toBeCloseTo(-94, 1);
  });

  it('adds equal powers to 3 dB above one of them', () => {
    expect(sumDbm([-85, -85])).toBeCloseTo(-85 + 3.0103, 3);
  });

  it('is dominated by the strongest contributor', () => {
    // Adding something 20 dB down barely moves the total.
    expect(sumDbm([-80, -100])).toBeCloseTo(-79.957, 2);
  });

  it('counts resource blocks sensibly for a 20 MHz LTE channel', () => {
    expect(resourceBlockCount(20e6, 15_000)).toBe(100);
  });
});

describe('RSRP and SINR', () => {
  const tx = {
    totalPowerDbm: 46,
    antennaGainDbi: 18,
    feederLossDb: 0.5,
    resourceBlocks: 100,
  };

  it('computes EIRP from power, feeder loss and gain', () => {
    expect(eirp(tx)).toBeCloseTo(63.5, 6);
  });

  it('spreads total power across resource elements for RSRP', () => {
    // 46 - 10log10(1200) - 0.5 + 18 - 120 = -87.3 dBm.
    const value = rsrp({ tx, pathLossDb: 120 });
    expect(value).toBeCloseTo(-87.29, 1);
  });

  it('stays about 30 dB below the wideband RSSI at 100 resource blocks', () => {
    const perElement = rsrp({ tx, pathLossDb: 120 });
    expect(rssi(perElement, 100) - perElement).toBeCloseTo(30.79, 1);
  });

  it('subtracts indoor loss from RSRP', () => {
    const outdoor = rsrp({ tx, pathLossDb: 120 });
    const indoor = rsrp({ tx, pathLossDb: 120, rxLossDb: 18 });
    expect(outdoor - indoor).toBeCloseTo(18, 6);
  });

  it('gives 0 dB SINR when one interferer matches the serving cell', () => {
    // S/(I+N) with S = I and N negligible is 1, so 0 dB -- not -3 dB. The
    // serving cell does not appear in its own denominator. Getting this wrong
    // is the other classic SINR bug, after summing in the log domain.
    const result = sinr({ servingDbm: -85, interferersDbm: [-85], noiseDbm: -120 });
    expect(result.sinrDb).toBeCloseTo(0, 2);
    expect(result.cirDb).toBeCloseTo(0, 2);
  });

  it('gives -3 dB SINR against two equal interferers', () => {
    const result = sinr({ servingDbm: -85, interferersDbm: [-85, -85], noiseDbm: -130 });
    expect(result.sinrDb).toBeCloseTo(-3.01, 1);
  });

  it('becomes noise-limited when nothing interferes', () => {
    const result = sinr({ servingDbm: -100, interferersDbm: [], noiseDbm: -115 });
    expect(result.sinrDb).toBeCloseTo(15, 2);
    expect(result.snrDb).toBeCloseTo(15, 6);
    expect(result.cirDb).toBe(Number.POSITIVE_INFINITY);
  });

  it('distinguishes noise-limited from interference-limited conditions', () => {
    const noiseLimited = sinr({ servingDbm: -115, interferersDbm: [-140], noiseDbm: -118 });
    const interferenceLimited = sinr({ servingDbm: -80, interferersDbm: [-82], noiseDbm: -118 });

    // In the first, removing interference changes little.
    expect(noiseLimited.snrDb - noiseLimited.sinrDb).toBeLessThan(0.5);
    // In the second, it changes everything.
    expect(interferenceLimited.snrDb - interferenceLimited.sinrDb).toBeGreaterThan(20);
  });

  it('degrades SINR as interferers are added', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let count = 0; count <= 5; count++) {
      const interferersDbm = Array.from({ length: count }, () => -90);
      const result = sinr({ servingDbm: -85, interferersDbm, noiseDbm: -120 });
      expect(result.sinrDb).toBeLessThan(previous);
      previous = result.sinrDb;
    }
  });

  it('references noise per subcarrier for RSRP comparison', () => {
    // -174 + 10log10(15000) + 7 = -125.2 dBm.
    expect(noisePerSubcarrier(15_000, 7)).toBeCloseTo(-125.24, 1);
  });
});

describe('throughput mapping', () => {
  it('rises monotonically with SINR under Shannon', () => {
    let previous = -1;
    for (const sinrDb of [-5, 0, 5, 10, 15, 20]) {
      const bps = shannonThroughput(sinrDb, 20e6);
      expect(bps).toBeGreaterThan(previous);
      previous = bps;
    }
  });

  it('caps Shannon at the modulation ceiling', () => {
    const extreme = shannonThroughput(60, 20e6);
    expect(extreme).toBeCloseTo(20e6 * 7.4063, -3);
  });

  it('keeps the CQI ladder monotonic in both threshold and efficiency', () => {
    for (let i = 1; i < CQI_TABLE_256QAM.length; i++) {
      expect(CQI_TABLE_256QAM[i]!.sinrThresholdDb).toBeGreaterThan(
        CQI_TABLE_256QAM[i - 1]!.sinrThresholdDb,
      );
      expect(CQI_TABLE_256QAM[i]!.spectralEfficiency).toBeGreaterThan(
        CQI_TABLE_256QAM[i - 1]!.spectralEfficiency,
      );
    }
  });

  it('reports outage below the lowest CQI', () => {
    const result = cqiThroughput(-15, 20e6);
    expect(result.cqi).toBe(0);
    expect(result.throughputBps).toBe(0);
    expect(result.modulation).toBeNull();
  });

  it('selects the top CQI well above threshold', () => {
    const result = cqiThroughput(30, 20e6);
    expect(result.cqi).toBe(15);
    expect(result.modulation).toBe('256QAM');
  });

  it('selects QPSK at the cell edge and 256QAM at the cell centre', () => {
    expect(cqiThroughput(-3, 20e6).modulation).toBe('QPSK');
    expect(cqiThroughput(18, 20e6).modulation).toBe('256QAM');
  });

  it('walks the DVB-S2X ladder with C/N', () => {
    const clearSky = dvbs2xThroughput(14, 30e6);
    const lightRain = dvbs2xThroughput(8, 30e6);
    const heavyRain = dvbs2xThroughput(2, 30e6);

    expect(clearSky.outage).toBe(false);
    expect(clearSky.throughputBps).toBeGreaterThan(lightRain.throughputBps);
    expect(lightRain.throughputBps).toBeGreaterThan(heavyRain.throughputBps);
    expect(heavyRain.modcod?.name).toContain('QPSK');
  });

  it('reports outage when no MODCOD closes', () => {
    const result = dvbs2xThroughput(-6, 30e6);
    expect(result.outage).toBe(true);
    expect(result.throughputBps).toBe(0);
    expect(result.marginDb).toBeLessThan(0);
  });

  it('keeps a positive margin on the selected MODCOD', () => {
    const result = dvbs2xThroughput(12, 30e6);
    expect(result.marginDb).toBeGreaterThanOrEqual(0);
  });
});

describe('satellite link budget', () => {
  it('computes C/N0 from the link equation', () => {
    const result = satelliteLink({
      eirpDbw: 55,
      fsplDb: 210,
      gaseousDb: 0.5,
      rainDb: 0,
      cloudDb: 0,
      otherDb: 1,
      gOverTDbK: 18,
      bandwidthHz: 30e6,
    });
    // 55 - 211.5 + 18 + 228.6 = 90.1 dB-Hz.
    expect(result.cOverN0DbHz).toBeCloseTo(90.1, 1);
    expect(result.cOverNDb).toBeCloseTo(90.1 - 74.77, 1);
  });

  it('separates the weather penalty from the clear-sky budget', () => {
    const base = {
      eirpDbw: 55,
      fsplDb: 210,
      gaseousDb: 0.5,
      cloudDb: 0.5,
      otherDb: 1,
      gOverTDbK: 18,
      bandwidthHz: 30e6,
    };
    const result = satelliteLink({ ...base, rainDb: 12 });
    expect(result.weatherPenaltyDb).toBeCloseTo(12.5, 6);
    expect(result.clearSkyCOverNDb - result.cOverNDb).toBeCloseTo(12.5, 6);
  });

  it('computes G/T as gain minus noise temperature in dB', () => {
    expect(gOverT(39, 150)).toBeCloseTo(39 - 21.76, 1);
  });

  it('raises sky noise as attenuation grows', () => {
    expect(skyNoiseTemperature(0)).toBeCloseTo(0, 6);
    // 3 dB of fade in a 275 K atmosphere radiates about half of it back.
    expect(skyNoiseTemperature(3)).toBeGreaterThan(120);
    expect(skyNoiseTemperature(3)).toBeLessThan(150);
    expect(skyNoiseTemperature(30)).toBeGreaterThan(270);
  });

  it('shows rain degrading the link from both ends at once', () => {
    const clearSkyTemp = systemNoiseTemperature({ skyTempK: 10, noiseFigureDb: 1.2 });
    const rainyTemp = systemNoiseTemperature({
      skyTempK: skyNoiseTemperature(3),
      noiseFigureDb: 1.2,
    });
    const gtClear = gOverT(39, clearSkyTemp);
    const gtRainy = gOverT(39, rainyTemp);

    // The attenuation alone is 3 dB; the noise rise costs extra on top.
    const extraLoss = gtClear - gtRainy;
    expect(extraLoss).toBeGreaterThan(1.5);
  });
});

describe('orbital mechanics', () => {
  it('gives the geostationary radius from the geostationary mean motion', () => {
    expect(semiMajorAxis(1.0027379093) / 1000).toBeCloseTo(42_164, 0);
  });

  it('gives a sidereal-day period at geostationary mean motion', () => {
    expect(orbitalPeriod(1.0027379093)).toBeCloseTo(86_164, -1);
  });

  it('solves Kepler for a circular orbit trivially', () => {
    expect(solveKepler(1.0, 0)).toBeCloseTo(1.0, 12);
  });

  it('solves Kepler for an eccentric orbit consistently', () => {
    const e = 0.3;
    for (const M of [0.1, 1.0, 2.5, 4.0, 6.0]) {
      const E = solveKepler(M, e);
      expect(E - e * Math.sin(E)).toBeCloseTo(M, 10);
    }
  });

  it('parses a TLE with the implied decimal and exponent fields', () => {
    const line1 = '1 25544U 98067A   24001.50000000  .00016717  00000+0  10270-3 0  9005';
    const line2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49270571 10000';
    const elements = parseTle(line1, line2, 'ISS (ZARYA)');

    expect(elements.name).toBe('ISS (ZARYA)');
    expect(elements.catalogNumber).toBe(25544);
    expect(elements.inclinationDeg).toBeCloseTo(51.6416, 4);
    expect(elements.eccentricity).toBeCloseTo(0.0006703, 7);
    expect(elements.meanMotionRevPerDay).toBeCloseTo(15.49270571, 8);
    expect(elements.bstar).toBeCloseTo(0.1027e-3, 9);
    // Epoch day 1.5 of 2024 is 1 January 2024 at 12:00 UTC.
    expect(new Date(elements.epochMs).toISOString()).toBe('2024-01-01T12:00:00.000Z');
  });

  it('keeps GMST inside one revolution and advancing', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const g0 = gmstDeg(t0);
    const g1 = gmstDeg(t0 + 3_600_000);
    expect(g0).toBeGreaterThanOrEqual(0);
    expect(g0).toBeLessThan(360);
    // One hour advances sidereal time by about 15.04 degrees.
    expect(((g1 - g0 + 360) % 360)).toBeCloseTo(15.041, 1);
  });

  it('holds a geostationary satellite over its assigned longitude', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    // SES-17 sits at 67 degrees east, serving the Jio Space Fiber footprint.
    const sat = geostationaryOrbit('SES-17', 67, epochMs);

    for (const hours of [0, 6, 12, 18, 24]) {
      const obs = observe(sat, { latDeg: 0, lonDeg: 67, altM: 0 }, epochMs + hours * 3_600_000, 0);
      expect(obs.subSatellite.lonDeg).toBeCloseTo(67, 0);
      expect(Math.abs(obs.subSatellite.latDeg)).toBeLessThan(0.5);
      expect(obs.elevationDeg).toBeGreaterThan(88);
      expect(obs.rangeM / 1000).toBeCloseTo(35_786, -2);
    }
  });

  it('puts a GEO satellite lower in the sky from higher latitudes', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    const sat = geostationaryOrbit('SES-17', 67, epochMs);

    const equator = observe(sat, { latDeg: 0, lonDeg: 67, altM: 0 }, epochMs, 0).elevationDeg;
    const delhi = observe(sat, { latDeg: 28.61, lonDeg: 77.21, altM: 216 }, epochMs, 0).elevationDeg;
    const srinagar = observe(sat, { latDeg: 34.08, lonDeg: 74.8, altM: 1585 }, epochMs, 0).elevationDeg;

    expect(equator).toBeGreaterThan(delhi);
    expect(delhi).toBeGreaterThan(srinagar);
    // Northern India still sees a comfortable elevation to a 67E bird.
    expect(srinagar).toBeGreaterThan(45);
  });

  it('gives a LEO satellite a roughly 95 minute period', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    const sat = circularOrbit({
      name: 'OneWeb-like',
      altitudeKm: 1200,
      inclinationDeg: 87.9,
      raanDeg: 0,
      phaseDeg: 0,
      epochMs,
    });
    expect(orbitalPeriod(sat.meanMotionRevPerDay) / 60).toBeGreaterThan(100);
    expect(orbitalPeriod(sat.meanMotionRevPerDay) / 60).toBeLessThan(115);
  });

  it('keeps a circular orbit at constant radius', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    const sat = circularOrbit({
      name: 'test',
      altitudeKm: 550,
      inclinationDeg: 53,
      raanDeg: 0,
      phaseDeg: 0,
      epochMs,
    });

    const expectedRadius = WGS84_A + 550_000;
    for (const minutes of [0, 10, 20, 40, 80]) {
      const state = propagate(sat, epochMs + minutes * 60_000);
      const radius = Math.hypot(state.position.x, state.position.y, state.position.z);
      expect(radius).toBeCloseTo(expectedRadius, -3);
    }
  });

  it('finds passes for a LEO satellite over a ground station', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    const sat = circularOrbit({
      name: 'LEO',
      altitudeKm: 550,
      inclinationDeg: 53,
      raanDeg: 120,
      phaseDeg: 0,
      epochMs,
    });

    const passes = findPasses(
      sat,
      { latDeg: 19.076, lonDeg: 72.8777, altM: 14 },
      epochMs,
      epochMs + 24 * 3_600_000,
      10,
      20_000,
    );

    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      const durationMin = (pass.endMs - pass.startMs) / 60_000;
      // A 550 km pass above 10 degrees lasts a handful of minutes.
      expect(durationMin).toBeGreaterThan(1);
      expect(durationMin).toBeLessThan(15);
      expect(pass.peakElevationDeg).toBeGreaterThan(10);
    }
  });

  it('shrinks the footprint as the elevation mask rises', () => {
    const atHorizon = footprintRadius(550_000, 0);
    const at10 = footprintRadius(550_000, 10);
    const at40 = footprintRadius(550_000, 40);

    expect(atHorizon).toBeGreaterThan(at10);
    expect(at10).toBeGreaterThan(at40);
    // Geometric horizon radius for 550 km is around 2 500 km.
    expect(atHorizon / 1000).toBeGreaterThan(2_200);
    expect(atHorizon / 1000).toBeLessThan(2_700);
    // Above 40 degrees it collapses to a few hundred kilometres.
    expect(at40 / 1000).toBeLessThan(700);
  });

  it('lengthens the slant range as elevation falls', () => {
    const zenith = slantRangeAtElevation(550_000, 90);
    const low = slantRangeAtElevation(550_000, 10);
    expect(zenith).toBeCloseTo(550_000, -2);
    // A 550 km satellite at 10 degrees elevation is about 1 815 km away:
    // more than three times the slant range straight overhead, which is
    // 10.4 dB of extra path loss across a single pass.
    expect(low / 1000).toBeGreaterThan(1_750);
    expect(low / 1000).toBeLessThan(1_900);
    expect(low / zenith).toBeGreaterThan(3);
  });

  it('gives LEO a large Doppler shift and GEO essentially none', () => {
    // Ku band at 12 GHz, a LEO closing at 7 km/s.
    const leo = dopplerShiftHz(12e9, -7000);
    expect(leo).toBeGreaterThan(250_000);
    expect(leo).toBeLessThan(300_000);
    // The sign convention: approaching raises the frequency.
    expect(dopplerShiftHz(12e9, 7000)).toBeLessThan(0);
    expect(Math.abs(dopplerShiftHz(12e9, 1))).toBeLessThan(100);
  });

  it('selects the highest satellite in a constellation', () => {
    const epochMs = Date.UTC(2026, 0, 1);
    const constellation = [0, 60, 120, 180, 240, 300].map((phase) =>
      circularOrbit({
        name: `sat-${phase}`,
        altitudeKm: 1200,
        inclinationDeg: 87.9,
        raanDeg: 0,
        phaseDeg: phase,
        epochMs,
      }),
    );

    const station = { latDeg: 19.076, lonDeg: 72.8777, altM: 14 };
    let found = 0;
    for (let minutes = 0; minutes < 120; minutes += 5) {
      const best = bestSatellite(constellation, station, epochMs + minutes * 60_000, 10);
      if (!best) continue;
      found++;
      // Nothing else visible may be higher.
      for (const other of constellation) {
        const obs = observe(other, station, epochMs + minutes * 60_000, 10);
        if (obs.visible) {
          expect(best.observation.elevationDeg).toBeGreaterThanOrEqual(obs.elevationDeg - 1e-9);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
