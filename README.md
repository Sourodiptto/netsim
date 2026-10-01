# netsim — 3D world network heatmap simulator

An interactive globe that predicts terrestrial and satellite network strength
from physics, not from decoration. The models are the ones operator planning
tools use — Atoll, Infovista Planet, Ericsson ASSET, Huawei U-Net — and the
ITU-R recommendations those tools implement.

**Status: Phase 0 complete.** The simulation kernel is written, typed and
validated: 146 tests passing against published reference values. The globe
renderer is next.

```bash
npm install
npm test          # 146 validation tests
npm run typecheck
npm run dev       # renderer — Phase 1, not built yet
```

---

## Why a kernel before a renderer

A 3D globe with glowing dots is a weekend. A simulator is the physics
underneath it, and the physics is only worth anything if it is checkable. So
the kernel is pure TypeScript with no DOM, no WebGL and no framework
dependency — it runs in a Web Worker, in Node under the test suite, and would
run server-side unchanged. The renderer will import from it; it imports
nothing from the renderer.

The test suite is the deliverable that makes "simulation grade" a claim rather
than a word. It pins outputs against values published by the ITU and 3GPP, not
against previous outputs of this code.

---

## The parameters, and how each one actually couples in

The brief asked for satellite position, air PPM, air density, network strength
and the positions required to derive network strength. Here is what each one
physically does in the model, which is not always what you would guess.

### Air PPM

Ambiguous until you name the species, so the kernel handles both and treats
them differently because the physics does.

**Water-vapour ppmv** is the one that changes answers. It drives the
22.235 GHz absorption line via ITU-R P.676 and it dominates the wet term of
radio refractivity. Dynamic range is large and real: a few hundred ppm in cold
dry air, over 30 000 ppm in Mumbai during the monsoon.

**CO₂ ppm** is carried separately and applied honestly. There is no CO₂
absorption line below 300 GHz worth modelling, and its effect on dry-air
refractivity is a derived second-order shift — doubling CO₂ moves refractivity
by under 0.1 N-units against water vapour's ~47. The coefficient is derived
from molecular polarizability rather than fitted, and the test suite asserts
that it stays small. Inflating it to make a slider feel important would be the
dishonest option.

### Air density

The parameter that turns out to be most interesting, because it does not just
attenuate — **it bends the horizon**.

```
pressure + temperature + humidity
  → refractivity N                      ITU-R P.453
  → vertical gradient dN/dh
  → k-factor, effective Earth radius    ITU-R P.310 / P.452
  → radio horizon and terrain bulge
  → which towers a point can even see
  → how much diffraction loss the ones over the horizon suffer
```

Density is not an independent free parameter: setting it implies a pressure
through the gas law, and that pressure flows into oxygen absorption and
refractivity. `pressureFromDensity` exists so the coupling cannot be bypassed.

The consequences are large enough to see on a map. A 30 m tower reaches
22.6 km under the standard k = 4/3 gradient and about 19.6 km if the gradient
flattens to zero — a fifth of the coverage radius lost to weather alone. Past
−157 N/km the ray curvature matches the Earth's and energy is trapped in a
surface duct, carrying signal far beyond its nominal horizon. Operators see
both; it is why planning tools carry a k-factor field at all.

### Satellite position — absolute and relative

Absolute position is an orbit problem: TLE mean elements, J2-perturbed
Keplerian propagation, ECI → ECEF via GMST.

Relative position is what a ground terminal experiences, and it is where the
system behaviour lives — azimuth, elevation, slant range, range rate. Elevation
sets the air mass and therefore atmospheric loss; slant range sets path loss;
range rate sets the Doppler the modem must track. A 550 km satellite at 10°
elevation is 1 815 km away against 550 km overhead: 10.4 dB of extra path loss
inside a single pass.

### Network strength

Not one number. The kernel reports RSRP, SINR, and — deliberately — SNR and
C/I separately, because a map showing poor SINR raises an actionable question
that only the decomposition answers: is this cell **noise-limited** (needs
power or a closer site) or **interference-limited** (needs tilt, azimuth or
reuse changes)? Those call for opposite interventions.

Then SINR → throughput, because coverage and capacity are different problems.
A cell edge at −110 dBm is "covered" and delivers a few megabits.

### The other positions

Tower lat/lon/height, sector azimuth, mechanical and electrical tilt, EIRP,
band, bandwidth; receiver position and height; terrain elevation; land-use
clutter class; rain rate. Antenna configuration gets disproportionate attention
because it is the cheapest lever in a real network — changing a tilt is a
software command, changing a site is a year of acquisition and civil works.

---

## Model stack

### Atmosphere

| Model | Standard | Notes |
|---|---|---|
| Layered standard atmosphere | ISO 2533 | Full 7-layer hydrostatic, not the single-troposphere shortcut |
| Water-vapour profile | ITU-R P.835 | 2 km scale height, anchored to measured surface conditions |
| Radio refractivity | ITU-R P.453 | `N = 77.6/T (p + 4810e/T)`, dry/wet split reported separately |
| k-factor, effective Earth radius | ITU-R P.310, P.452 | Gradient derived from the profile, never typed in |
| Ray bending | Bouguer invariant | Integrated through the profile, not a fitted polynomial |
| Gaseous absorption | ITU-R P.676 Annex 2 | All nine water lines; **integrated** along the slant path |
| Rain specific attenuation | ITU-R P.838-3 | Full Gaussian coefficient fits, both polarizations |
| Rain height | ITU-R P.839 | Latitude fallback until the isotherm raster is loaded |
| Earth-space rain fade | ITU-R P.618-13 | Horizontal reduction, vertical adjustment, p-scaling |
| Terrestrial rain fade | ITU-R P.530-18 | Distance-dependent path reduction factor |
| Cloud and fog | ITU-R P.840-8 | Double-Debye dielectric model for liquid water |

Two deliberate departures from the recommendations, both toward more rigour:

**Gaseous absorption is integrated, not equivalent-heighted.** P.676 Annex 2
offers equivalent heights fitted for the reference atmosphere. The entire point
of exposing pressure, temperature and humidity as controls is that the user
leaves the reference atmosphere, so a path integral through the actual profile
is both more accurate under those conditions and easier to reason about. It
also makes low-elevation links come out right instead of degrading as 1/sin θ —
the result stays finite at 0° elevation.

**Ray bending is traced, not fitted.** In a spherically stratified medium
Bouguer's rule holds exactly, so the accumulated refraction is
`τ = −∫ (dn/dr)/(n tan θ) dr`. Integrating that over the profile means the
answer responds to the user's actual air density instead of to a coefficient
fitted for one atmosphere.

### Terrestrial propagation

| Model | Standard | Use |
|---|---|---|
| Free-space path loss | — | The hard floor; asserted in tests |
| Fresnel-zone geometry | — | First-zone clearance, the number a planner reads |
| Knife-edge diffraction | ITU-R P.526 eq. 31 | 6.0 dB at grazing incidence |
| Bullington | ITU-R P.452 | With the `(10 + 0.02d)` empirical correction |
| Epstein–Peterson | — | Best for well-separated ridges |
| Deygout, ± Causebrook | — | Planning-tool default; two variants, because they disagree |
| Okumura–Hata | — | 150–1500 MHz, the sub-GHz coverage layer |
| COST-231 Hata | — | 1500–2000 MHz |
| Standard Propagation Model | — | Calibrated; takes a real diffraction loss as input |
| Land-use clutter | ITU-R P.452 Table 4 | Heights geometric, losses calibration parameters |

Three diffraction constructions rather than one, because operator tools let you
pick and the choice is a calibration question, not a physics one. Deygout and
Deygout–Causebrook disagree by several decibels over rolling terrain; which
matches drive-test data is something you measure.

SPM's coefficients are anchored so the model reproduces COST-231 Hata at the
reference geometry, and the test suite asserts it. That makes the defaults
traceable rather than invented — if they diverge, it is a bug.

### Network layer

3GPP TR 38.901 3D antenna element patterns with azimuth and tilt; per-resource-
element RSRP; interference aggregated in linear power; SINR with its noise- and
interference-limited decomposition; throughput via Shannon with an
implementation haircut, the 3GPP CQI table 2 ladder, or DVB-S2X MODCODs for
satellite. Satellite link budgets include the noise-temperature coupling that
makes rain cost more than its attenuation figure suggests — an absorbing
atmosphere is also an emitter, so 3 dB of fade both attenuates the carrier and
radiates ~137 K into the antenna.

### Orbits

J2-perturbed Keplerian propagation from TLE mean elements. **This is not
SGP4**, and the module says so in its header: it captures nodal regression and
apsidal precession but omits drag, solar radiation pressure, lunisolar terms
and short-period effects. For a LEO satellite the position error reaches a few
kilometres within a day of epoch. For elevation angles, slant range and
footprint geometry at the resolution a heatmap renders, that is immaterial; for
pointing a real antenna, it is not. The TLE parser is exact, so dropping in a
full SGP4 requires no change above that layer.

---

## Validation

146 tests. The useful ones are not the round-trips — they are the independent
reference pins:

- Equatorial degree of longitude against the exact `a·π/180`; meridian degree
  against the published 110 574.389 m
- ISA sea-level and tropopause states; density 1.225 kg/m³
- Standard surface refractivity ≈ 315 N-units; k = 157/118 from the derived
  gradient
- Oxygen absorption ≈ 0.0065 dB/km at 1.8 GHz; water vapour ≈ 0.18 dB/km on
  the 22.235 GHz line
- **ITU-R P.838-3 k and α at 10, 12, 20, 30 and 40 GHz, both polarizations**,
  pinned exactly by exploiting the fact that τ = 0 on a horizontal path
  collapses the polarization mixing to kH/αH
- Free-space loss at 1 km; 6 dB per doubling in distance and frequency
- 6.0 dB knife-edge loss at grazing incidence
- Exactly −3 dB at the half-power beamwidth
- SPM reproducing COST-231 at the reference geometry
- GEO radius 42 164 km from the sidereal mean motion; a geostationary satellite
  holding its longitude across a day
- Doppler at Ku band for a LEO closing at 7 km/s

Plus structural invariants that catch more bugs than any single value: no model
may predict less loss than free space; loss must rise with distance and
frequency; the CQI ladder must be monotonic in both threshold and efficiency;
interference must aggregate in linear power.

Two of these tests exist because the first draft got them wrong, and the notes
on them stay in the file:

- **P.838-1 and P.838-3 genuinely disagree** by up to 20% — the 2005 revision
  recomputed the scattering with different drop-size assumptions. Checking new
  code against an old table looks like a code bug and is not one.
- **SINR with one matched interferer is 0 dB, not −3 dB.** The serving cell
  does not appear in its own denominator. This is the second classic SINR bug,
  after summing powers in the log domain.

### Known limitations, stated rather than buried

- Gaseous absorption is implemented for **1–54 GHz** and returns `NaN` above
  it. The 60 GHz oxygen complex needs different P.676 branches; extrapolating
  a formula past its stated validity is worse than refusing.
- Orbit propagation is J2-Keplerian, not SGP4 (see above).
- Clutter loss values are representative defaults. In real use they are tuned
  against drive-test data per market and per band — which is why they are
  exposed as data rather than buried in a formula.
- CQI SINR thresholds are **not** in the 3GPP standard. 3GPP specifies the
  modulation and code rate of each index but not the SINR it needs; that comes
  from link-level simulation and depends on channel model, receiver and target
  BLER. These are representative 10% BLER values and the most tunable numbers
  in the repo.
- Diffraction is knife-edge throughout. Real terrain is rounded, which costs a
  few more decibels; that gap is absorbed by clutter corrections rather than
  pretended away.

---

## Roadmap

- **Phase 0 — simulation kernel.** Done. Geodesy, atmosphere, propagation,
  antennas, link budgets, orbits, 146 validation tests.
- **Phase 1 — globe and terrestrial heatmap.** R3F globe; per-pixel link budget
  in a GLSL fragment shader with towers packed into a data texture; the CPU
  kernel as the reference implementation the shader is validated against;
  progressive refinement (coarse on slider drag, full resolution on release)
  with dirty-flag recompute rather than per-frame.
- **Phase 2 — satellite layer.** Real constellations: Jio Space Fiber
  (SES-17 GEO + O3b mPOWER MEO) against Airtel–Eutelsat OneWeb (LEO). Same
  globe, visibly different handover and fade behaviour — the clearest way to
  show why orbit choice is an architecture decision.
- **Phase 3 — automatic cell planning.** Candidate site scoring, greedy plus
  simulated annealing against a weighted objective (covered population,
  capacity, overlap penalty, site cost). This is the actual algorithm family
  behind tower positioning, and the part that makes the tool answer a question
  rather than draw a picture.
- **Phase 4 — scenarios.** Mumbai dense-urban, Rajasthan rural, Himalayan
  terrain-limited. Export, and a written case study.

### Deferred by choice

3GPP TR 38.901 stochastic channel (LOS probability, shadow-fading correlation,
O2I penetration). The deterministic path-loss interfaces are shaped to accept
it. Left out of the first build because fading realizations make a heatmap
noisy rather than more truthful, and the empirical-plus-diffraction tier is
what operator tools predict with day to day.

---

## Data

Real datasets, not synthetic. See [`public/data/README.md`](public/data/README.md)
for sources, licences and attribution requirements — OpenCelliD is ODbL and
requires attribution, which is a condition and not a footnote.
