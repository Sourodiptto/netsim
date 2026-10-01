/**
 * Mapping SINR to throughput.
 *
 * Coverage maps lie a little: a cell edge at -110 dBm RSRP is "covered" but
 * delivers a few megabits, while the same pixel 500 m closer delivers two
 * hundred. Capacity, not coverage, is what drives site counts in an urban
 * build, so the simulator reports both.
 *
 * Three mappings, in increasing realism:
 *
 *   shannonThroughput  -- the information-theoretic ceiling with an
 *                         implementation-efficiency haircut. Smooth, which
 *                         makes it good for optimisation objectives.
 *   cqiThroughput      -- the 3GPP discrete modulation and coding ladder.
 *                         Steps rather than a curve, which is what a real
 *                         device experiences.
 *   dvbs2xThroughput   -- the satellite equivalent, from the DVB-S2X MODCOD
 *                         table, where the steps are coarser and the
 *                         thresholds are published rather than inferred.
 */

import { dbToLin } from '../core/math';

/**
 * Maximum spectral efficiency of 256QAM at code rate 948/1024, bps/Hz.
 * The ceiling of 3GPP CQI table 2, per layer.
 */
export const MAX_SPECTRAL_EFFICIENCY_256QAM = 7.4063;

export interface ShannonOptions {
  /** Implementation efficiency, 0 to 1. Real systems reach 0.6 to 0.75 of Shannon. */
  efficiency?: number;
  /** Spatial multiplexing layers. */
  layers?: number;
  /** Per-layer spectral efficiency ceiling, bps/Hz. */
  maxSpectralEfficiency?: number;
}

/**
 * Shannon-bounded throughput, bits per second.
 *
 * C = B * eta * layers * log2(1 + SINR), clipped at the modulation ceiling.
 * The efficiency factor covers control overhead, pilot density, cyclic prefix
 * and the gap between practical codes and the channel capacity; 0.7 is the
 * conventional figure for LTE and NR downlink and is what 3GPP calibration
 * exercises settle around.
 */
export function shannonThroughput(
  sinrDb: number,
  bandwidthHz: number,
  options: ShannonOptions = {},
): number {
  const efficiency = options.efficiency ?? 0.7;
  const layers = options.layers ?? 1;
  const ceiling = options.maxSpectralEfficiency ?? MAX_SPECTRAL_EFFICIENCY_256QAM;

  const spectralEfficiency = Math.min(ceiling, efficiency * Math.log2(1 + dbToLin(sinrDb)));
  return Math.max(0, bandwidthHz * spectralEfficiency * layers);
}

export interface CqiEntry {
  cqi: number;
  modulation: 'QPSK' | '16QAM' | '64QAM' | '256QAM';
  /** Code rate as a fraction of 1024. */
  codeRate1024: number;
  /** Spectral efficiency, bps/Hz. */
  spectralEfficiency: number;
  /**
   * SINR at which this index becomes usable, dB.
   *
   * Not in the standard. 3GPP specifies the modulation and code rate of each
   * index but not the SINR it needs -- that comes from link-level simulation
   * and depends on channel model, receiver, and the target block error rate.
   * These are representative values for 10% BLER on a typical fading channel,
   * and they are the single most tunable set of numbers in this file.
   */
  sinrThresholdDb: number;
}

/**
 * 3GPP TS 38.214 CQI table 2, the 256QAM table used by NR.
 *
 * Spectral efficiencies are the standard's own values. Thresholds are not;
 * see the note on sinrThresholdDb.
 */
export const CQI_TABLE_256QAM: readonly CqiEntry[] = [
  { cqi: 1, modulation: 'QPSK', codeRate1024: 78, spectralEfficiency: 0.1523, sinrThresholdDb: -6.9 },
  { cqi: 2, modulation: 'QPSK', codeRate1024: 193, spectralEfficiency: 0.377, sinrThresholdDb: -4.0 },
  { cqi: 3, modulation: 'QPSK', codeRate1024: 449, spectralEfficiency: 0.877, sinrThresholdDb: -1.0 },
  { cqi: 4, modulation: '16QAM', codeRate1024: 378, spectralEfficiency: 1.4766, sinrThresholdDb: 1.0 },
  { cqi: 5, modulation: '16QAM', codeRate1024: 490, spectralEfficiency: 1.9141, sinrThresholdDb: 3.0 },
  { cqi: 6, modulation: '16QAM', codeRate1024: 616, spectralEfficiency: 2.4063, sinrThresholdDb: 5.0 },
  { cqi: 7, modulation: '64QAM', codeRate1024: 466, spectralEfficiency: 2.7305, sinrThresholdDb: 6.6 },
  { cqi: 8, modulation: '64QAM', codeRate1024: 567, spectralEfficiency: 3.3223, sinrThresholdDb: 8.5 },
  { cqi: 9, modulation: '64QAM', codeRate1024: 666, spectralEfficiency: 3.9023, sinrThresholdDb: 10.5 },
  { cqi: 10, modulation: '64QAM', codeRate1024: 772, spectralEfficiency: 4.5234, sinrThresholdDb: 12.5 },
  { cqi: 11, modulation: '64QAM', codeRate1024: 873, spectralEfficiency: 5.1152, sinrThresholdDb: 14.5 },
  { cqi: 12, modulation: '256QAM', codeRate1024: 711, spectralEfficiency: 5.5547, sinrThresholdDb: 16.0 },
  { cqi: 13, modulation: '256QAM', codeRate1024: 797, spectralEfficiency: 6.2266, sinrThresholdDb: 17.8 },
  { cqi: 14, modulation: '256QAM', codeRate1024: 885, spectralEfficiency: 6.9141, sinrThresholdDb: 19.8 },
  { cqi: 15, modulation: '256QAM', codeRate1024: 948, spectralEfficiency: 7.4063, sinrThresholdDb: 21.5 },
];

export interface CqiResult {
  /** Selected CQI, or 0 when the link cannot be established at all. */
  cqi: number;
  /** Spectral efficiency of the selected index, bps/Hz. */
  spectralEfficiency: number;
  /** Throughput, bits per second. */
  throughputBps: number;
  /** Modulation order in use, or null below CQI 1. */
  modulation: CqiEntry['modulation'] | null;
}

/**
 * Pick the highest CQI the SINR supports and report the resulting rate.
 *
 * Below CQI 1 the link does not close: the device is in coverage by RSRP but
 * cannot carry data. That state is worth rendering distinctly on a map rather
 * than as "0 Mbps", because its fix is different from the fix for a slow cell.
 */
export function cqiThroughput(
  sinrDb: number,
  bandwidthHz: number,
  layers = 1,
  table: readonly CqiEntry[] = CQI_TABLE_256QAM,
): CqiResult {
  let selected: CqiEntry | null = null;
  for (const entry of table) {
    if (sinrDb >= entry.sinrThresholdDb) selected = entry;
    else break;
  }

  if (!selected) {
    return { cqi: 0, spectralEfficiency: 0, throughputBps: 0, modulation: null };
  }

  return {
    cqi: selected.cqi,
    spectralEfficiency: selected.spectralEfficiency,
    throughputBps: bandwidthHz * selected.spectralEfficiency * layers,
    modulation: selected.modulation,
  };
}

export interface ModCod {
  name: string;
  /** Required Es/N0 for quasi-error-free operation, dB. */
  requiredEsN0Db: number;
  /** Spectral efficiency, bps/Hz. */
  spectralEfficiency: number;
}

/**
 * DVB-S2 / S2X modulation and coding set, a representative subset.
 *
 * Required Es/N0 figures are the published quasi-error-free thresholds for
 * normal FECFRAME at a packet error rate of 1e-7, per ETSI EN 302 307. Unlike
 * the cellular CQI thresholds these are standardised, which is why a
 * satellite link budget can be argued to a tenth of a decibel while a
 * cellular one cannot.
 *
 * Adaptive coding and modulation walks this ladder as rain comes and goes:
 * a Ka-band terminal that runs 32APSK 5/6 in clear sky drops to QPSK 1/4
 * in heavy rain, trading an 8x throughput loss for staying connected. That
 * graceful degradation is why modern satellite broadband does not simply
 * fall over in weather.
 */
export const DVBS2X_MODCODS: readonly ModCod[] = [
  { name: 'QPSK 1/4', requiredEsN0Db: -2.35, spectralEfficiency: 0.49 },
  { name: 'QPSK 1/3', requiredEsN0Db: -1.24, spectralEfficiency: 0.656 },
  { name: 'QPSK 1/2', requiredEsN0Db: 1.0, spectralEfficiency: 0.989 },
  { name: 'QPSK 3/5', requiredEsN0Db: 2.23, spectralEfficiency: 1.188 },
  { name: 'QPSK 2/3', requiredEsN0Db: 3.1, spectralEfficiency: 1.322 },
  { name: 'QPSK 3/4', requiredEsN0Db: 4.03, spectralEfficiency: 1.487 },
  { name: 'QPSK 5/6', requiredEsN0Db: 5.18, spectralEfficiency: 1.654 },
  { name: '8PSK 3/5', requiredEsN0Db: 5.5, spectralEfficiency: 1.78 },
  { name: '8PSK 2/3', requiredEsN0Db: 6.62, spectralEfficiency: 1.98 },
  { name: '8PSK 3/4', requiredEsN0Db: 7.91, spectralEfficiency: 2.228 },
  { name: '16APSK 2/3', requiredEsN0Db: 8.97, spectralEfficiency: 2.637 },
  { name: '8PSK 5/6', requiredEsN0Db: 9.35, spectralEfficiency: 2.479 },
  { name: '16APSK 3/4', requiredEsN0Db: 10.21, spectralEfficiency: 2.967 },
  { name: '16APSK 4/5', requiredEsN0Db: 11.03, spectralEfficiency: 3.166 },
  { name: '16APSK 5/6', requiredEsN0Db: 11.61, spectralEfficiency: 3.3 },
  { name: '32APSK 3/4', requiredEsN0Db: 12.73, spectralEfficiency: 3.703 },
  { name: '32APSK 4/5', requiredEsN0Db: 13.64, spectralEfficiency: 3.952 },
  { name: '32APSK 5/6', requiredEsN0Db: 14.28, spectralEfficiency: 4.12 },
];

export interface ModCodResult {
  /** The selected MODCOD, or null when even the most robust one fails. */
  modcod: ModCod | null;
  /** Throughput, bits per second. */
  throughputBps: number;
  /** Margin above the selected MODCOD's requirement, dB. */
  marginDb: number;
  /** True when no MODCOD closes: the link is down. */
  outage: boolean;
}

/**
 * Select a DVB-S2X MODCOD for a given C/N and report the resulting rate.
 *
 * The table is sorted by threshold, and selection walks it for the most
 * efficient entry that still closes with the requested implementation margin.
 */
export function dvbs2xThroughput(
  cOverNDb: number,
  symbolRateBaud: number,
  implementationMarginDb = 1.0,
): ModCodResult {
  const usable = cOverNDb - implementationMarginDb;

  let selected: ModCod | null = null;
  for (const modcod of DVBS2X_MODCODS) {
    if (usable >= modcod.requiredEsN0Db) {
      if (!selected || modcod.spectralEfficiency > selected.spectralEfficiency) {
        selected = modcod;
      }
    }
  }

  if (!selected) {
    const mostRobust = DVBS2X_MODCODS[0]!;
    return {
      modcod: null,
      throughputBps: 0,
      marginDb: usable - mostRobust.requiredEsN0Db,
      outage: true,
    };
  }

  return {
    modcod: selected,
    throughputBps: symbolRateBaud * selected.spectralEfficiency,
    marginDb: usable - selected.requiredEsN0Db,
    outage: false,
  };
}
