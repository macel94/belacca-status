import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { validateJsonSchema } from './schema-validation.mjs';

const fail = (message) => { throw new Error(message); };
const isDate = (value) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
const isURI = (value) => typeof value === 'string' && /^https?:\/\//u.test(value) && value.length <= 500;

export function validateBadge(data) {
  validateJsonSchema(data, 'badge');
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('badge must be an object');
  if (data.schemaVersion !== 1 || data.label !== 'public status' || !['operational', 'degraded', 'incident', 'unknown'].includes(data.message) || data.message !== data.status) fail('invalid badge state');
  const expectedColor = { operational: 'brightgreen', degraded: 'orange', incident: 'red', unknown: 'lightgrey' }[data.status];
  if (data.color !== expectedColor || data.labelColor !== '#555' || data.cacheSeconds !== 300) fail('invalid badge presentation');
  if (!isDate(data.observedAt) || !isDate(data.validUntil) || !isURI(data.sourceReference)) fail('invalid badge evidence metadata');
  if (data.status === 'unknown' && (data.observedAt !== null || data.validUntil !== null)) fail('unknown badge must not carry fresh evidence timestamps');
  if (data.status !== 'unknown' && (data.observedAt === null || data.validUntil === null)) fail('published badge must carry evidence timestamps');
  return true;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const path = process.argv[2] || 'badge.json';
  try {
    validateBadge(JSON.parse(await readFile(path, 'utf8')));
    console.log(`${path}: valid reusable status badge`);
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exitCode = 1;
  }
}
