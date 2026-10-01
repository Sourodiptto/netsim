/** Shared value types. Units are in the field name or the doc comment, always. */

/** Geodetic position on the WGS84 ellipsoid. */
export interface Geodetic {
  /** Latitude, degrees, positive north. */
  latDeg: number;
  /** Longitude, degrees, positive east. */
  lonDeg: number;
  /** Height above the WGS84 ellipsoid, metres. */
  altM: number;
}

/** Earth-centred, Earth-fixed Cartesian position, metres. */
export interface Ecef {
  x: number;
  y: number;
  z: number;
}

/** Earth-centred inertial (TEME) position, metres. */
export interface Eci {
  x: number;
  y: number;
  z: number;
}

/** Local east-north-up offset from an origin, metres. */
export interface Enu {
  e: number;
  n: number;
  u: number;
}

/** Topocentric look angles from an observer to a target. */
export interface LookAngles {
  /** Azimuth, degrees clockwise from true north. */
  azimuthDeg: number;
  /** Elevation above the local horizontal, degrees. Negative means below horizon. */
  elevationDeg: number;
  /** Straight-line distance, metres. */
  rangeM: number;
}

/** Atmospheric state at a point. The simulator's weather input. */
export interface AtmosphericState {
  /** Total air pressure, hPa. */
  pressureHpa: number;
  /** Air temperature, kelvin. */
  temperatureK: number;
  /** Water-vapour density, g/m³. */
  waterVapourDensity: number;
  /** CO₂ volume mixing ratio, ppm. Affects the dry-air refractivity term. */
  co2Ppm: number;
  /** Rain rate, mm/h. Zero for a clear-sky run. */
  rainRateMmH: number;
  /** Liquid water content of cloud, g/m³. Zero for clear sky. */
  cloudLiquidWater: number;
}
