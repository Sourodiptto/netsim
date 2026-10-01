#!/usr/bin/env node
/**
 * Fetch the datasets that can be fetched without an account.
 *
 * Right now that is Celestrak TLEs. The terrain, clutter, population and
 * ITU-R rain rasters need either an account or a manual download of several
 * gigabytes, so they are documented in public/data/README.md rather than
 * automated into a surprise.
 *
 * Nothing here runs unless you invoke it. It writes only into public/data.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'public', 'data', 'tle');

/**
 * Celestrak element groups.
 *
 * Kept narrow on purpose: these are the constellations the simulator has a
 * reason to show, not a mirror of the catalogue. Celestrak asks that bulk
 * data not be redistributed, so these land in a gitignored directory.
 */
const GROUPS = [
  { name: 'geo', group: 'geo', note: 'Geostationary, includes SES-17 at 67E' },
  { name: 'oneweb', group: 'oneweb', note: 'Airtel-Eutelsat OneWeb LEO' },
  { name: 'starlink', group: 'starlink', note: 'Starlink LEO, for comparison' },
  { name: 'ses', group: 'ses', note: 'SES fleet, includes O3b mPOWER MEO' },
  { name: 'gnss', group: 'gnss', note: 'Navigation constellations' },
];

const BASE = 'https://celestrak.org/NORAD/elements/gp.php';

async function fetchGroup({ name, group, note }) {
  const url = `${BASE}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  process.stdout.write(`  ${name.padEnd(10)} ${note}\n`);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'netsim/0.1 (research simulator)' },
  });

  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  // A TLE file is groups of three lines; anything much shorter is an error page.
  if (text.length < 100 || !text.includes('\n1 ')) {
    throw new Error(`${name}: response does not look like a TLE file`);
  }

  const satellites = text.split('\n').filter((l) => l.startsWith('1 ')).length;
  await writeFile(join(dataDir, `${name}.txt`), text, 'utf8');
  process.stdout.write(`  ${''.padEnd(10)} -> ${satellites} satellites\n`);
}

async function main() {
  await mkdir(dataDir, { recursive: true });

  process.stdout.write('Fetching TLE sets from celestrak.org\n');
  process.stdout.write('(free for non-commercial use; do not redistribute in bulk)\n\n');

  const failures = [];
  for (const entry of GROUPS) {
    try {
      await fetchGroup(entry);
    } catch (error) {
      failures.push(`${entry.name}: ${error.message}`);
    }
  }

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stdout.write('Some groups failed:\n');
    for (const f of failures) process.stdout.write(`  ${f}\n`);
  }
  process.stdout.write(
    'Terrain, clutter, population and ITU-R rain rasters are not automated.\n' +
      'See public/data/README.md for sources and licence conditions.\n',
  );

  if (failures.length === GROUPS.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
