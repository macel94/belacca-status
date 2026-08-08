import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { validateJsonSchema } from './schema-validation.mjs';

const fail = (message) => { throw new Error(message); };
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonEmpty = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;

export function validateStatus(data, { now = Date.now(), allowExpired = false } = {}) {
  validateJsonSchema(data, 'status');
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('status must be an object');
  if (data.schema_version !== 'belacca.public-status.v2') fail('unsupported schema_version');
  if (data.sanitized !== true) fail('status is not sanitized');
  if (data.publication_state === 'not_configured') {
    if (data.status !== 'unknown' || data.observation_id !== null || data.observed_at !== null || data.updated_at !== null || data.evidence_timestamp !== null || data.valid_until !== null || data.monitoring_policy !== null || data.components?.length !== 0 || data.incidents?.length !== 0) fail('invalid bootstrap artifact');
    return true;
  }
  if (data.publication_state !== 'published') fail('invalid publication_state');
  if (!['operational', 'degraded', 'incident', 'unknown'].includes(data.status)) fail('invalid aggregate status');
  if (!nonEmpty(data.summary, 240) || !nonEmpty(data.observation_id, 120)) fail('invalid summary or observation_id');
  for (const field of ['observed_at', 'updated_at', 'evidence_timestamp', 'valid_until']) if (!isDate(data[field])) fail(`invalid ${field}`);
  if (!allowExpired && Date.parse(data.valid_until) <= now) fail('status artifact is expired');
  if (!data.publisher || !nonEmpty(data.publisher.name, 120) || !nonEmpty(data.publisher.source_reference)) fail('invalid publisher');
  const policy = data.monitoring_policy;
  if (!policy || !nonEmpty(policy.id, 120) || !nonEmpty(policy.approved_by, 120) || !isDate(policy.approved_at) || !nonEmpty(policy.runner, 120) || !nonEmpty(policy.interval, 40) || !nonEmpty(policy.freshness_ttl, 40) || !Number.isInteger(policy.failure_threshold) || !Number.isInteger(policy.recovery_threshold)) fail('invalid monitoring policy');
  if (!data.uptime || !['not_configured', 'reported'].includes(data.uptime.state)) fail('invalid uptime state');
  if (data.uptime.state === 'reported' && (typeof data.uptime.value !== 'number' || data.uptime.value < 0 || data.uptime.value > 100 || !nonEmpty(data.uptime.window, 40) || !nonEmpty(data.uptime.source_reference))) fail('invalid reported uptime');
  if (!Array.isArray(data.components) || data.components.length === 0 || data.components.length > 20) fail('invalid components');
  for (const component of data.components) {
    if (!component || !nonEmpty(component.id, 80) || !nonEmpty(component.name, 100) || typeof component.critical !== 'boolean' || !['operational', 'degraded', 'incident', 'unknown'].includes(component.status) || !nonEmpty(component.summary, 240) || !isDate(component.evidence_timestamp) || !Number.isInteger(component.duration_ms) || component.duration_ms < 0 || !Array.isArray(component.source_references) || component.source_references.length === 0) fail('invalid component');
  }
  if (!Array.isArray(data.incidents) || data.incidents.length > 20) fail('invalid incidents');
  for (const incident of data.incidents) {
    if (!incident || !nonEmpty(incident.id, 100) || !['investigating', 'identified', 'monitoring', 'resolved'].includes(incident.status) || !nonEmpty(incident.summary, 240) || !isDate(incident.started_at) || !isDate(incident.updated_at) || !Array.isArray(incident.source_references) || incident.source_references.length === 0) fail('invalid incident');
  }
  if (!Array.isArray(data.source_references) || data.source_references.length === 0 || !Array.isArray(data.notes)) fail('invalid references or notes');
  return true;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const path = process.argv[2] || 'status.json';
  try {
    validateStatus(JSON.parse(await readFile(path, 'utf8')), { allowExpired: process.argv.includes('--allow-expired') });
    console.log(`${path}: valid and fresh`);
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exitCode = 1;
  }
}
