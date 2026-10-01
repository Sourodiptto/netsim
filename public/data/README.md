# Datasets

Nothing in this directory is committed except this file. The datasets are
large and several carry licence conditions that travel with the data, so they
are fetched rather than vendored.

Run `npm run data:fetch` for the automatable parts. The rest need an account
or a manual download, and are listed here with what they need.

## Licence conditions that are actual conditions

**OpenCelliD — ODbL 1.0.** Attribution is required, and so is share-alike on
any derived database that gets distributed. If tower data from OpenCelliD ends
up in a published build, the UI has to carry the attribution. This is not a
courtesy.

**GEBCO** — free to use, attribution requested in the form GEBCO specifies.

**WorldPop — CC BY 4.0.** Attribution required.

**Celestrak TLEs** — free for non-commercial use; redistribution of bulk data
is restricted. Fetch at runtime or cache briefly rather than committing
snapshots.

**ITU-R digital maps (P.837, P.839, P.840)** — distributed with the
recommendations from itu.int. Free to download; check the terms on the
recommendation page before redistributing the rasters.

## Sources

| Dataset | What it gives | Source | Automatable |
|---|---|---|---|
| Celestrak TLEs | Real orbital elements for GEO/MEO/LEO constellations | celestrak.org/NORAD/elements | Yes |
| GEBCO 2024 grid | Global terrain and bathymetry, 15 arc-second | gebco.net | Manual (large) |
| SRTM 30 m | High-resolution terrain for zoomed regions | earthexplorer.usgs.gov | Account needed |
| OpenCelliD | Real cell tower locations and bands | opencellid.org | Account needed |
| WorldPop | Population raster, for coverage-by-population KPIs | worldpop.org | Manual |
| ESA WorldCover | Land-use classes, to drive the clutter sampler | esa-worldcover.org | Manual |
| ITU-R P.837 | Rain rate exceeded 0.01% of the year | itu.int/rec/R-REC-P.837 | Manual |
| ITU-R P.839 | 0 °C isotherm height, replacing the latitude fallback | itu.int/rec/R-REC-P.839 | Manual |

## Constellations worth loading first

The India-relevant satellite broadband picture, which is also the clearest
demonstration of why orbit choice is an architecture decision rather than a
detail:

- **Jio Space Fiber** — SES-17 (GEO, 67° E) plus O3b mPOWER (MEO, ~8 062 km).
  High elevation from Indian latitudes, negligible Doppler, no handover on the
  GEO leg; ~120 ms one-way latency.
- **Airtel–Eutelsat OneWeb** — LEO at 1 200 km, 87.9° inclination. Low latency,
  but constant handover and hundreds of kilohertz of Doppler to track.

Same globe, same atmosphere, same rain. Entirely different link behaviour.

## Falling back without data

Every sampler in the kernel has a synthetic default — `flatTerrain`,
`uniformClutter`, `ISA_SURFACE`, and `circularOrbit`/`geostationaryOrbit` for
constellations built without a TLE. The kernel and its tests run with no
datasets present at all, which keeps `npm test` a clean checkout away.
