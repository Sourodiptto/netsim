/**
 * Physical and geodetic constants.
 *
 * Every value here is a published reference constant, not a tuning knob.
 * Tunable model parameters live beside the model that uses them.
 */

/** Speed of light in vacuum, m/s (CODATA, exact by SI definition). */
export const C_LIGHT = 299_792_458;

/** Boltzmann constant, J/K (CODATA, exact by SI definition). */
export const K_BOLTZMANN = 1.380_649e-23;

/** Boltzmann constant in dBW/(K·Hz): 10·log10(k). */
export const K_BOLTZMANN_DB = 10 * Math.log10(K_BOLTZMANN);

/** Standard gravity, m/s². */
export const G_STANDARD = 9.806_65;

/** Specific gas constant for dry air, J/(kg·K). */
export const R_DRY_AIR = 287.058;

/** Specific gas constant for water vapour, J/(kg·K). */
export const R_WATER_VAPOUR = 461.495;

/** WGS84 semi-major axis, m. */
export const WGS84_A = 6_378_137.0;

/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257_223_563;

/** WGS84 semi-minor axis, m. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);

/** WGS84 first eccentricity squared: 2f − f². */
export const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;

/** WGS84 second eccentricity squared: (a² − b²)/b². */
export const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

/** Mean Earth radius used for spherical shortcuts (IUGG arithmetic mean), m. */
export const EARTH_MEAN_RADIUS = 6_371_008.8;

/** Earth gravitational parameter GM, m³/s² (WGS84/EGM96). */
export const EARTH_MU = 3.986_004_418e14;

/** Earth rotation rate, rad/s (WGS84 sidereal). */
export const EARTH_ROTATION_RATE = 7.292_115e-5;

/** Second zonal harmonic of Earth's gravity field (drives orbital precession). */
export const EARTH_J2 = 1.082_626_68e-3;

/** Sidereal day, seconds. */
export const SIDEREAL_DAY = 86_164.0905;

/**
 * Standard reference noise temperature, K. Receiver noise figures are quoted
 * relative to this, so thermal noise floor = −174 dBm/Hz at T0.
 */
export const T0_NOISE = 290;

/** Thermal noise power spectral density at T0, dBm/Hz. */
export const NOISE_PSD_DBM_HZ = 10 * Math.log10(K_BOLTZMANN * T0_NOISE * 1000);

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
