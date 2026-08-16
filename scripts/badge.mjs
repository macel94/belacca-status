import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { validateStatus } from './validate-status.mjs';

const COLORS = {
  operational: 'brightgreen',
  degraded: 'orange',
  incident: 'red',
  unknown: 'lightgrey',
};

export function buildBadge(status, { now = Date.now() } = {}) {
  validateStatus(status, { now, allowExpired: true });
  const fresh = status.publication_state === 'published'
    && typeof status.valid_until === 'string'
    && Date.parse(status.valid_until) > now;
  const state = fresh ? status.status : 'unknown';
  return {
    schemaVersion: 1,
    label: 'public status',
    message: state,
    color: COLORS[state],
    labelColor: '#555',
    cacheSeconds: 300,
    status: state,
    observedAt: fresh && state !== 'unknown' ? status.observed_at : null,
    validUntil: fresh && state !== 'unknown' ? status.valid_until : null,
    sourceReference: fresh
      ? status.publisher.source_reference
      : 'https://francesco.belacca.com/status.html',
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = args.input || 'status.json';
    const output = args.output || 'badge.json';
    const status = JSON.parse(await readFile(input, 'utf8'));
    const badge = buildBadge(status);
    await writeFile(resolve(output), `${JSON.stringify(badge, null, 2)}\n`);
    console.log(`generated ${output}: ${badge.message}`);
  } catch (error) {
    console.error(`badge generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
