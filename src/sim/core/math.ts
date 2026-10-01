/** Small numeric helpers shared across the kernel. */

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse lerp, unclamped. Returns 0 when a === b. */
export const invLerp = (a: number, b: number, x: number): number =>
  a === b ? 0 : (x - a) / (b - a);

/** dB → linear power ratio. */
export const dbToLin = (db: number): number => Math.pow(10, db / 10);

/** Linear power ratio → dB. Guards log(0) by flooring at −400 dB. */
export const linToDb = (lin: number): number => (lin <= 0 ? -400 : 10 * Math.log10(lin));

/** dBm → milliwatts. */
export const dbmToMw = (dbm: number): number => Math.pow(10, dbm / 10);

/** Milliwatts → dBm. */
export const mwToDbm = (mw: number): number => (mw <= 0 ? -400 : 10 * Math.log10(mw));

/**
 * Sum a list of powers given in dBm. Used for interference aggregation, where
 * adding in the log domain would be wrong.
 */
export const sumDbm = (values: readonly number[]): number => {
  let mw = 0;
  for (const v of values) mw += dbmToMw(v);
  return mwToDbm(mw);
};

/** Wrap an angle in degrees to [0, 360). */
export const wrap360 = (deg: number): number => ((deg % 360) + 360) % 360;

/** Wrap an angle in degrees to [−180, 180). */
export const wrap180 = (deg: number): number => wrap360(deg + 180) - 180;

/** Shortest signed angular difference a − b, in degrees, within [−180, 180). */
export const angleDiff = (a: number, b: number): number => wrap180(a - b);

/** Linear interpolation over a sorted x table. Clamps at both ends. */
export const interp = (x: number, xs: readonly number[], ys: readonly number[]): number => {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  if (n === 1 || x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]!) / (xs[hi]! - xs[lo]!);
  return lerp(ys[lo]!, ys[hi]!, t);
};
