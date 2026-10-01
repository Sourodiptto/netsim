/**
 * Free-space path loss and Fresnel-zone geometry.
 *
 * The floor under every other model here. Nothing in the simulator may return
 * a path loss below free space over the same distance: that would mean the
 * channel delivered more power than an isotropic radiator in vacuum, and it
 * is the single most useful sanity assertion in the test suite.
 */

import { C_LIGHT } from '../core/constants';

/** Wavelength from frequency, metres. */
export function wavelength(freqHz: number): number {
  return C_LIGHT / freqHz;
}

/** Wavelength from a frequency in MHz, metres. */
export function wavelengthMhz(freqMhz: number): number {
  return C_LIGHT / (freqMhz * 1e6);
}

/**
 * Free-space path loss, dB.
 *
 * L = 20 log10(d) + 20 log10(f) + 32.44, with d in km and f in MHz. The
 * constant folds in 20 log10(4 pi / c) with those units.
 */
export function freeSpacePathLoss(distanceM: number, freqMhz: number): number {
  const d = Math.max(1e-3, distanceM) / 1000;
  return 20 * Math.log10(d) + 20 * Math.log10(freqMhz) + 32.44;
}

/**
 * Radius of the nth Fresnel zone at a point along a path, metres.
 *
 * r_n = sqrt(n * lambda * d1 * d2 / (d1 + d2)).
 *
 * The first zone is the one that matters: an obstruction intruding past about
 * 40% of r_1 starts costing real power, and clearing 60% of r_1 is the
 * standard microwave-link design rule. This is the quantity that turns a
 * terrain profile into a diffraction loss.
 */
export function fresnelRadius(d1M: number, d2M: number, freqMhz: number, zone = 1): number {
  const total = d1M + d2M;
  if (total <= 0) return 0;
  return Math.sqrt((zone * wavelengthMhz(freqMhz) * d1M * d2M) / total);
}

/**
 * Fresnel-Kirchhoff diffraction parameter for a knife edge.
 *
 * nu = h * sqrt(2 (d1 + d2) / (lambda d1 d2)), where h is the obstruction
 * height above the straight line joining the terminals -- negative when the
 * edge is below the line. Sign convention matters: positive nu means a
 * blocked path.
 */
export function diffractionParameter(
  obstructionHeightM: number,
  d1M: number,
  d2M: number,
  freqMhz: number,
): number {
  const total = d1M + d2M;
  if (d1M <= 0 || d2M <= 0) return 0;
  const lambda = wavelengthMhz(freqMhz);
  return obstructionHeightM * Math.sqrt((2 * total) / (lambda * d1M * d2M));
}

/**
 * Single knife-edge diffraction loss, dB. ITU-R P.526 eq. 31.
 *
 * J(nu) = 6.9 + 20 log10(sqrt((nu - 0.1)^2 + 1) + nu - 0.1), for nu > -0.78.
 *
 * Below -0.78 the approximation is taken as zero loss: the obstruction is far
 * enough below the path that it no longer interferes. At nu = 0 -- grazing
 * incidence, the edge exactly on the line of sight -- it gives 6.0 dB, which
 * is the textbook value and a good single-point check.
 */
export function knifeEdgeLoss(nu: number): number {
  if (nu <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1);
}
