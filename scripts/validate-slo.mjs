import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { SERVICE_DEFINITIONS, SLO_POLICY, SLO_TARGET, WINDOW_HOURS } from './slo-evidence.mjs';
import { validateJsonSchema } from './schema-validation.mjs';

const fail = (message) => { throw new Error(message); };
const isDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonEmpty = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max;
const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const rounded = (value) => Number(value.toFixed(6));

function object(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('unexpected property');
  if (required.some((key) => !Object.hasOwn(value, key))) fail('missing property');
}

function references(value, max = 10) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every((item) => nonEmpty(item))) fail('invalid source references');
}

function validatePolicy(policy) {
  object(policy, ['id', 'approved_by', 'approved_at', 'target', 'target_percent', 'window', 'window_hours', 'cadence', 'unknown_policy', 'sla', 'service_credits', 'recovery_objective', 'description'], [
    'id', 'approved_by', 'approved_at', 'target', 'target_percent', 'window', 'window_hours', 'cadence', 'unknown_policy', 'sla', 'service_credits', 'recovery_objective', 'description',
  ]);
  if (policy.id !== SLO_POLICY.id || !nonEmpty(policy.approved_by, 120) || !isDate(policy.approved_at) || policy.target !== SLO_TARGET || policy.target_percent !== '99%' || policy.window !== '30d' || policy.window_hours !== WINDOW_HOURS || policy.cadence !== '1h' || !nonEmpty(policy.unknown_policy) || policy.sla !== false || policy.service_credits !== false || !nonEmpty(policy.description)) fail('invalid SLO policy');
  const recovery = policy.recovery_objective;
  object(recovery, ['type', 'target', 'excluded_from_availability_arithmetic', 'description'], ['type', 'target', 'excluded_from_availability_arithmetic', 'description']);
  if (recovery.type !== 'controlled_drill' || recovery.target !== 'under 6 minutes' || recovery.excluded_from_availability_arithmetic !== true || !nonEmpty(recovery.description)) fail('invalid recovery objective');
}

function validateCounts(counts) {
  object(counts, ['expected_slots', 'observed_slots', 'good_slots', 'bad_slots', 'unknown_slots', 'duplicate_slots', 'invalid_records'], ['expected_slots', 'observed_slots', 'good_slots', 'bad_slots', 'unknown_slots', 'duplicate_slots', 'invalid_records']);
  for (const field of ['observed_slots', 'good_slots', 'bad_slots', 'unknown_slots', 'duplicate_slots', 'invalid_records']) {
    if (!Number.isInteger(counts[field]) || counts[field] < 0) fail('invalid SLO counts');
  }
  if (counts.expected_slots !== WINDOW_HOURS || counts.observed_slots !== counts.good_slots + counts.bad_slots || counts.observed_slots + counts.unknown_slots !== WINDOW_HOURS || counts.good_slots + counts.bad_slots > WINDOW_HOURS) fail('inconsistent SLO counts');
}

function validateErrorBudget(value, badSlots, observedSlots) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid error budget');
  object(value, ['allowed_bad_slots', 'consumed_bad_slots', 'consumed_percent', 'remaining_bad_slots', 'remaining_percent'], ['allowed_bad_slots', 'consumed_bad_slots', 'consumed_percent', 'remaining_bad_slots', 'remaining_percent']);
  const allowedBadSlots = rounded(observedSlots * (1 - SLO_TARGET));
  if (value.allowed_bad_slots !== allowedBadSlots || value.consumed_bad_slots !== badSlots || !finiteNumber(value.consumed_percent) || !finiteNumber(value.remaining_bad_slots) || !finiteNumber(value.remaining_percent) || value.consumed_percent < 0 || value.remaining_bad_slots < 0 || value.remaining_percent < 0 || value.remaining_percent > 100) fail('invalid error budget values');
}

function validateService(service, index, evaluationEnd) {
  const definition = SERVICE_DEFINITIONS[index];
  object(service, ['id', 'name', 'scope', 'state', 'measurement_window', 'target', 'target_percent', 'window', 'cadence', 'indicator', 'evaluation_window', 'counts', 'coverage_percent', 'sli_percent', 'error_budget', 'latest_evidence_timestamp', 'source_references'], [
    'id', 'name', 'scope', 'state', 'measurement_window', 'target', 'target_percent', 'window', 'cadence', 'indicator', 'evaluation_window', 'counts', 'coverage_percent', 'sli_percent', 'error_budget', 'latest_evidence_timestamp', 'source_references',
  ]);
  if (service.id !== definition.id || service.name !== definition.name || service.scope !== 'public' || !['not_configured', 'measured', 'reportable'].includes(service.state) || !['available_history', 'rolling_30d'].includes(service.measurement_window) || service.target !== SLO_TARGET || service.target_percent !== '99%' || service.window !== '30d' || service.cadence !== '1h' || !nonEmpty(service.indicator, 300)) fail('invalid service policy');
  const window = service.evaluation_window;
  object(window, ['start', 'end', 'expected_slots'], ['start', 'end', 'expected_slots']);
  if (!isDate(window.start) || window.end !== evaluationEnd || !isDate(window.end) || window.expected_slots !== WINDOW_HOURS || Date.parse(window.end) - Date.parse(window.start) !== (WINDOW_HOURS - 1) * 60 * 60 * 1000) fail('invalid service evaluation window');
  validateCounts(service.counts);
  if (!finiteNumber(service.coverage_percent) || service.coverage_percent < 0 || service.coverage_percent > 100 || service.coverage_percent !== rounded((service.counts.observed_slots / WINDOW_HOURS) * 100)) fail('invalid service coverage');
  const complete = service.counts.unknown_slots === 0 && service.counts.invalid_records === 0;
  const expectedState = service.counts.observed_slots === 0 ? 'not_configured' : complete ? 'reportable' : 'measured';
  if (service.state !== expectedState || (service.state === 'reportable' && service.measurement_window !== 'rolling_30d') || (service.state === 'not_configured' && service.measurement_window !== 'available_history')) fail('invalid service measurement state');
  if (service.state === 'not_configured') {
    if (service.sli_percent !== null || service.error_budget !== null) fail('numeric values reported without observations');
  } else {
    if (!finiteNumber(service.sli_percent) || service.sli_percent !== rounded((service.counts.good_slots / service.counts.observed_slots) * 100)) fail('invalid SLI');
    validateErrorBudget(service.error_budget, service.counts.bad_slots, service.counts.observed_slots);
  }
  if (service.latest_evidence_timestamp !== null && !isDate(service.latest_evidence_timestamp)) fail('invalid latest evidence timestamp');
  references(service.source_references);
}

export function validateSlo(data) {
  validateJsonSchema(data, 'slo');
  object(data, ['$schema', 'schema_version', 'sanitized', 'publication_state', 'generated_at', 'policy', 'evaluation', 'services', 'source_references', 'notes'], ['$schema', 'schema_version', 'sanitized', 'publication_state', 'generated_at', 'policy', 'evaluation', 'services', 'source_references', 'notes']);
  if (data.schema_version !== 'belacca.slo-evidence.v1' || data.sanitized !== true || data.publication_state !== 'published' || !isDate(data.generated_at)) fail('invalid SLO artifact metadata');
  validatePolicy(data.policy);
  const evaluation = data.evaluation;
  object(evaluation, ['window_start', 'window_end', 'expected_slots', 'cadence', 'source_history_schema', 'valid_records', 'invalid_records'], ['window_start', 'window_end', 'expected_slots', 'cadence', 'source_history_schema', 'valid_records', 'invalid_records']);
  if (!isDate(evaluation.window_start) || evaluation.window_end !== data.generated_at || !isDate(evaluation.window_end) || evaluation.expected_slots !== WINDOW_HOURS || evaluation.cadence !== '1h' || evaluation.source_history_schema !== 'belacca.observation.v1' || !Number.isInteger(evaluation.valid_records) || evaluation.valid_records < 0 || !Number.isInteger(evaluation.invalid_records) || evaluation.invalid_records < 0 || Date.parse(evaluation.window_end) - Date.parse(evaluation.window_start) !== (WINDOW_HOURS - 1) * 60 * 60 * 1000) fail('invalid SLO evaluation');
  if (!Array.isArray(data.services) || data.services.length !== SERVICE_DEFINITIONS.length || new Set(data.services.map((service) => service?.id)).size !== data.services.length) fail('invalid SLO services');
  for (let index = 0; index < data.services.length; index += 1) validateService(data.services[index], index, data.generated_at);
  references(data.source_references, 10);
  if (!Array.isArray(data.notes) || data.notes.length < 1 || data.notes.length > 20 || !data.notes.every((note) => nonEmpty(note))) fail('invalid SLO notes');
  return true;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const path = process.argv[2] || 'slo.json';
  try {
    validateSlo(JSON.parse(await readFile(path, 'utf8')));
    console.log(`${path}: valid sanitized SLO evidence`);
  } catch (error) {
    console.error(`${path}: ${error.message}`);
    process.exitCode = 1;
  }
}
