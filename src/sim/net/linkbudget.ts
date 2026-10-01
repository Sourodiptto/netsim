/**
 * Link budgets, noise, and signal-to-interference-plus-noise ratio.
 *
 * This is where the physics becomes a number a planner argues about. Two
 * things are worth being pedantic about, because getting either wrong
 * invalidates a whole coverage map:
 *
 * 1. RSRP is a per-resource-element quantity, not a total power. A sector
 *    radiating 46 dBm across 100 LTE resource blocks puts 46 - 10log10(1200)
 *    = 15.2 dBm into each reference element. Comparing a total transmit power
 *    against an RSRP threshold overstates coverage by about 30 dB, which is
 *    a factor of a thousand in power and roughly a factor of six in cell
 *    radius.
 *
 * 2. Interference adds in linear power, never in dB. Summing dBm values
 *    directly is the most common bug in a hand-rolled SINR calculation, and
 *    it is why every aggregation here goes through sumDbm.
 */

import { NOISE_PSD_DBM_HZ } from '../core/constants';
import { dbmToMw, linToDb, mwToDbm, sumDbm } from '../core/math';

/**
 * Thermal noise power in a bandwidth, dBm.
 *
 * N = -174 dBm/Hz + 10 log10(B) + NF, where -174 is kT0 at the 290 K
 * reference the noise figure is defined against.
 */
export function thermalNoise(bandwidthHz: number, noiseFigureDb: number): number {
  return NOISE_PSD_DBM_HZ + 10 * Math.log10(Math.max(1, bandwidthHz)) + noiseFigureDb;
}

/** Number of resource elements in a bandwidth: 12 subcarriers per resource block. */
export function resourceElements(resourceBlocks: number): number {
  return 12 * Math.max(1, resourceBlocks);
}

/** Resource blocks available in a channel, from bandwidth and subcarrier spacing. */
export function resourceBlockCount(bandwidthHz: number, subcarrierSpacingHz: number): number {
  // 12 subcarriers per block, with roughly 10% guard band.
  return Math.floor((bandwidthHz * 0.9) / (12 * subcarrierSpacingHz));
}

export interface SectorTransmit {
  /** Total sector transmit power at the antenna connector, dBm. */
  totalPowerDbm: number;
  /** Antenna gain in the direction of the receiver, dBi. */
  antennaGainDbi: number;
  /** Feeder, connector and combiner losses, dB. */
  feederLossDb: number;
  /** Resource blocks the power is spread across. */
  resourceBlocks: number;
}

/** Effective isotropic radiated power in a direction, dBm. */
export function eirp(tx: SectorTransmit): number {
  return tx.totalPowerDbm - tx.feederLossDb + tx.antennaGainDbi;
}

/**
 * Reference signal received power, dBm.
 *
 * The per-resource-element power that a handset actually measures and reports,
 * and the quantity every coverage threshold in a network plan is written
 * against.
 */
export function rsrp(params: {
  tx: SectorTransmit;
  /** Total path loss including terrain, clutter and atmosphere, dB. */
  pathLossDb: number;
  /** Receiver antenna gain, dBi. Typically 0 or slightly negative for a handset. */
  rxGainDbi?: number;
  /** Body loss, indoor penetration and any other receiver-side loss, dB. */
  rxLossDb?: number;
}): number {
  const { tx, pathLossDb, rxGainDbi = 0, rxLossDb = 0 } = params;
  const perElement = tx.totalPowerDbm - 10 * Math.log10(resourceElements(tx.resourceBlocks));
  return perElement - tx.feederLossDb + tx.antennaGainDbi - pathLossDb + rxGainDbi - rxLossDb;
}

/** Wideband received signal strength across the whole channel, dBm. */
export function rssi(rsrpDbm: number, resourceBlocks: number): number {
  return rsrpDbm + 10 * Math.log10(resourceElements(resourceBlocks));
}

export interface SinrResult {
  /** Signal to interference plus noise ratio, dB. */
  sinrDb: number;
  /** Signal to noise ratio with interference removed, dB. Shows the noise-limited ceiling. */
  snrDb: number;
  /** Carrier to interference ratio, dB. Infinite when nothing interferes. */
  cirDb: number;
  /** Aggregate interference power, dBm. */
  interferenceDbm: number;
  /** Thermal noise power in the reference bandwidth, dBm. */
  noiseDbm: number;
}

/**
 * SINR from a serving signal and a list of co-channel interferers.
 *
 * All powers must be referenced to the same bandwidth: compare per-element
 * powers against per-element noise, or wideband against wideband, but never
 * mix. The function takes the serving RSRP and interferer RSRPs, so the
 * matching noise term is the per-subcarrier one.
 *
 * Returning SNR and C/I alongside SINR is deliberate. When a map shows poor
 * SINR, the actionable question is whether the cell is noise-limited (needs
 * more power or a closer site) or interference-limited (needs tilt, azimuth
 * or frequency reuse changes). Those call for opposite interventions, and
 * only the decomposition distinguishes them.
 */
export function sinr(params: {
  servingDbm: number;
  interferersDbm: readonly number[];
  /** Noise power in the same reference bandwidth as the signals, dBm. */
  noiseDbm: number;
}): SinrResult {
  const { servingDbm, interferersDbm, noiseDbm } = params;

  const interferenceDbm = interferersDbm.length > 0 ? sumDbm(interferersDbm) : Number.NEGATIVE_INFINITY;
  const interferenceMw = interferersDbm.length > 0 ? dbmToMw(interferenceDbm) : 0;
  const noiseMw = dbmToMw(noiseDbm);
  const signalMw = dbmToMw(servingDbm);

  return {
    sinrDb: linToDb(signalMw / (interferenceMw + noiseMw)),
    snrDb: servingDbm - noiseDbm,
    cirDb: interferenceMw > 0 ? servingDbm - interferenceDbm : Number.POSITIVE_INFINITY,
    interferenceDbm: interferersDbm.length > 0 ? interferenceDbm : mwToDbm(0),
    noiseDbm,
  };
}

/**
 * Noise power per subcarrier, dBm. The reference bandwidth that matches RSRP.
 */
export function noisePerSubcarrier(subcarrierSpacingHz: number, noiseFigureDb: number): number {
  return thermalNoise(subcarrierSpacingHz, noiseFigureDb);
}

export interface SatelliteLinkBudget {
  /** Satellite or gateway EIRP toward the terminal, dBW. */
  eirpDbw: number;
  /** Free-space path loss over the slant range, dB. */
  fsplDb: number;
  /** Gaseous absorption along the slant path, dB. */
  gaseousDb: number;
  /** Rain attenuation at the design availability, dB. */
  rainDb: number;
  /** Cloud attenuation, dB. */
  cloudDb: number;
  /** Scintillation and other residual losses, dB. */
  otherDb: number;
  /** Terminal gain-to-noise-temperature figure of merit, dB/K. */
  gOverTDbK: number;
  /** Occupied bandwidth, Hz. */
  bandwidthHz: number;
}

export interface SatelliteLinkResult {
  /** Carrier to noise density ratio, dB-Hz. */
  cOverN0DbHz: number;
  /** Carrier to noise ratio in the occupied bandwidth, dB. */
  cOverNDb: number;
  /** Total propagation loss, dB. */
  totalLossDb: number;
  /** Clear-sky C/N for comparison, dB. Rain and cloud removed. */
  clearSkyCOverNDb: number;
  /** How much the weather costs, dB. */
  weatherPenaltyDb: number;
}

/**
 * Satellite link budget.
 *
 * C/N0 = EIRP - L + G/T - k, with k = -228.6 dBW/(K*Hz). Everything in dBW
 * here rather than dBm, which is the satcom convention and worth keeping
 * because mixing the two is a 30 dB error.
 *
 * The clear-sky comparison is the useful output. A Ka-band link that closes
 * comfortably on a clear day and fails in rain is the normal condition, not a
 * design error; what matters is whether the margin covers the fade for the
 * target availability. Reporting both makes that visible instead of
 * collapsing it into one pass/fail number.
 */
export function satelliteLink(budget: SatelliteLinkBudget): SatelliteLinkResult {
  const weatherPenaltyDb = budget.rainDb + budget.cloudDb;
  const totalLossDb =
    budget.fsplDb + budget.gaseousDb + budget.rainDb + budget.cloudDb + budget.otherDb;

  // Boltzmann's constant in dBW/(K*Hz).
  const kDb = -228.6;

  const cOverN0DbHz = budget.eirpDbw - totalLossDb + budget.gOverTDbK - kDb;
  const bandwidthDb = 10 * Math.log10(Math.max(1, budget.bandwidthHz));

  return {
    cOverN0DbHz,
    cOverNDb: cOverN0DbHz - bandwidthDb,
    totalLossDb,
    clearSkyCOverNDb: cOverN0DbHz + weatherPenaltyDb - bandwidthDb,
    weatherPenaltyDb,
  };
}

/**
 * Figure of merit of a receiving terminal, dB/K.
 *
 * G/T is the one number that characterises a receiver, because it is what
 * falls out of the link equation -- antenna gain and system noise temperature
 * never appear separately. A bigger dish and a better LNA are
 * interchangeable, which is the trade every terminal design makes.
 */
export function gOverT(antennaGainDbi: number, systemNoiseTempK: number): number {
  return antennaGainDbi - 10 * Math.log10(Math.max(1, systemNoiseTempK));
}

/**
 * System noise temperature of a receiver, K.
 *
 * Antenna temperature plus the receiver's own contribution referred to its
 * input. Sky noise is not a constant: rain both attenuates the carrier and
 * radiates thermal noise into the antenna, so a rain fade degrades C/N from
 * both ends at once. That coupling is the reason heavy-rain outages arrive
 * faster than the attenuation figure alone suggests.
 */
export function systemNoiseTemperature(params: {
  /** Sky brightness temperature in the antenna beam, K. */
  skyTempK: number;
  /** Physical temperature of the antenna and feed, K. */
  antennaTempK?: number;
  /** Receiver noise figure, dB. */
  noiseFigureDb: number;
  /** Feed loss ahead of the first amplifier, dB. */
  feedLossDb?: number;
}): number {
  const { skyTempK, antennaTempK = 290, noiseFigureDb, feedLossDb = 0.3 } = params;
  const feedLossLin = 10 ** (feedLossDb / 10);
  const receiverTempK = 290 * (10 ** (noiseFigureDb / 10) - 1);
  // Sky noise attenuated by the feed, plus the feed's own thermal emission.
  return skyTempK / feedLossLin + antennaTempK * (1 - 1 / feedLossLin) + receiverTempK;
}

/**
 * Sky noise temperature raised by atmospheric attenuation, K.
 *
 * An absorbing atmosphere is also an emitter at its physical temperature:
 * T_sky = T_atm (1 - 10^(-A/10)). At 3 dB of rain fade a 275 K atmosphere
 * contributes about 137 K, which on a terminal with a 150 K clear-sky system
 * temperature nearly doubles the noise -- a further 3 dB lost on top of the
 * 3 dB of attenuation.
 */
export function skyNoiseTemperature(attenuationDb: number, atmosphericTempK = 275): number {
  return atmosphericTempK * (1 - 10 ** (-Math.max(0, attenuationDb) / 10));
}
