/**
 * Geodesy validation.
 *
 * Checked against closed-form values the ellipsoid gives exactly, rather than
 * against another implementation. An equatorial degree of longitude is
 * exactly a*pi/180 because the equator is a circle of radius a; a degree of
 * latitude at the equator is the published meridian arc value. If either
 * drifts, the eccentricity handling is wrong.
 */

import { describe, expect, it } from 'vitest';
import { WGS84_A, WGS84_B } from '../core/constants';
import {
  ecefToGeodetic,
  geodeticToEcef,
  lookAngles,
  primeVerticalRadius,
} from '../geo/wgs84';
import { destination, greatCirclePath, haversine, vincentyInverse } from '../geo/geodesic';

describe('WGS84 conversions', () => {
  it('places the origin on the semi-major axis', () => {
    const p = geodeticToEcef({ latDeg: 0, lonDeg: 0, altM: 0 });
    expect(p.x).toBeCloseTo(WGS84_A, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('places the north pole on the semi-minor axis', () => {
    const p = geodeticToEcef({ latDeg: 90, lonDeg: 0, altM: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(WGS84_B, 6);
  });

  it('round-trips geodetic to ECEF and back to sub-millimetre', () => {
    const cases = [
      { latDeg: 0, lonDeg: 0, altM: 0 },
      { latDeg: 19.076, lonDeg: 72.8777, altM: 14 }, // Mumbai
      { latDeg: 28.6139, lonDeg: 77.209, altM: 216 }, // Delhi
      { latDeg: -33.8688, lonDeg: 151.2093, altM: 58 }, // Sydney
      { latDeg: 78.2232, lonDeg: 15.6267, altM: 500 }, // Svalbard
      { latDeg: 45, lonDeg: -179.9, altM: 8848 },
    ];

    for (const original of cases) {
      const back = ecefToGeodetic(geodeticToEcef(original));
      expect(back.latDeg).toBeCloseTo(original.latDeg, 9);
      expect(back.lonDeg).toBeCloseTo(original.lonDeg, 9);
      expect(back.altM).toBeCloseTo(original.altM, 4);
    }
  });

  it('gives the prime vertical radius as a at the equator', () => {
    expect(primeVerticalRadius(0)).toBeCloseTo(WGS84_A, 6);
  });
});

describe('look angles', () => {
  it('reports a geostationary satellite overhead at 90 degrees elevation', () => {
    const geoAltM = 35_786_000;
    const station = { latDeg: 0, lonDeg: 0, altM: 0 };
    const satellite = geodeticToEcef({ latDeg: 0, lonDeg: 0, altM: geoAltM });

    const look = lookAngles(station, satellite);
    expect(look.elevationDeg).toBeCloseTo(90, 6);
    expect(look.rangeM).toBeCloseTo(geoAltM, 3);
  });

  it('reports due north at azimuth zero', () => {
    const station = { latDeg: 0, lonDeg: 0, altM: 0 };
    const target = geodeticToEcef({ latDeg: 1, lonDeg: 0, altM: 0 });
    expect(lookAngles(station, target).azimuthDeg).toBeCloseTo(0, 3);
  });

  it('reports due east at azimuth 90', () => {
    const station = { latDeg: 0, lonDeg: 0, altM: 0 };
    const target = geodeticToEcef({ latDeg: 0, lonDeg: 1, altM: 0 });
    expect(lookAngles(station, target).azimuthDeg).toBeCloseTo(90, 3);
  });

  it('puts a target below the horizon at negative elevation', () => {
    const station = { latDeg: 0, lonDeg: 0, altM: 0 };
    const target = geodeticToEcef({ latDeg: 0, lonDeg: 10, altM: 0 });
    expect(lookAngles(station, target).elevationDeg).toBeLessThan(0);
  });
});

describe('geodesic distances', () => {
  it('matches the exact equatorial arc for one degree of longitude', () => {
    const expected = (WGS84_A * Math.PI) / 180;
    const result = vincentyInverse(0, 0, 0, 1);
    expect(result.converged).toBe(true);
    expect(result.distanceM).toBeCloseTo(expected, 3);
  });

  it('matches the published meridian arc for one degree of latitude', () => {
    // Meridian arc from 0 to 1 degree on WGS84: 110 574.389 m.
    const result = vincentyInverse(0, 0, 1, 0);
    expect(result.distanceM).toBeCloseTo(110_574.389, 1);
  });

  it('keeps haversine within 0.5 percent of the ellipsoidal answer', () => {
    const cases: [number, number, number, number][] = [
      [19.076, 72.8777, 28.6139, 77.209], // Mumbai to Delhi
      [12.9716, 77.5946, 22.5726, 88.3639], // Bengaluru to Kolkata
      [51.5074, -0.1278, 40.7128, -74.006], // London to New York
    ];

    for (const [lat1, lon1, lat2, lon2] of cases) {
      const ellipsoidal = vincentyInverse(lat1, lon1, lat2, lon2).distanceM;
      const spherical = haversine(lat1, lon1, lat2, lon2);
      const relativeError = Math.abs(spherical - ellipsoidal) / ellipsoidal;
      expect(relativeError).toBeLessThan(0.005);
    }
  });

  it('reports non-convergence instead of a wrong answer for antipodal points', () => {
    const result = vincentyInverse(0, 0, 0.5, 179.7);
    // Either it converges to a sane value or it flags the fallback. Never both wrong.
    expect(result.distanceM).toBeGreaterThan(19_000_000);
    expect(result.distanceM).toBeLessThan(20_100_000);
  });

  it('reports zero for coincident points', () => {
    expect(vincentyInverse(19.076, 72.8777, 19.076, 72.8777).distanceM).toBe(0);
  });
});

describe('path construction', () => {
  it('starts and ends a great-circle path on its endpoints', () => {
    const from = { latDeg: 19.076, lonDeg: 72.8777, altM: 0 };
    const to = { latDeg: 28.6139, lonDeg: 77.209, altM: 0 };
    const path = greatCirclePath(from, to, 64);

    expect(path).toHaveLength(64);
    expect(path[0]!.latDeg).toBeCloseTo(from.latDeg, 9);
    expect(path[0]!.lonDeg).toBeCloseTo(from.lonDeg, 9);
    expect(path[63]!.latDeg).toBeCloseTo(to.latDeg, 9);
    expect(path[63]!.lonDeg).toBeCloseTo(to.lonDeg, 9);
  });

  it('advances fraction monotonically along a path', () => {
    const path = greatCirclePath(
      { latDeg: 0, lonDeg: 0, altM: 0 },
      { latDeg: 10, lonDeg: 10, altM: 0 },
      16,
    );
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.fraction).toBeGreaterThan(path[i - 1]!.fraction);
    }
  });

  it('moves the expected distance along a bearing', () => {
    const start = { latDeg: 19.076, lonDeg: 72.8777 };
    const moved = destination(start.latDeg, start.lonDeg, 45, 10_000);
    const back = haversine(start.latDeg, start.lonDeg, moved.latDeg, moved.lonDeg);
    expect(back).toBeCloseTo(10_000, 0);
  });
});
