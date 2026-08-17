import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

export const HOUR_MS = 60 * 60 * 1000;
export const WINDOW_HOURS = 30 * 24;
export const SLO_TARGET = 0.99;

export const SERVICE_DEFINITIONS = [
  {
    id: 'portfolio',
    name: 'Portfolio',
    component: 'portfolio',
    checks: ['portfolio-health', 'portfolio-homepage'],
    indicator: 'Successful external portfolio health and homepage observation',
  },
  {
    id: 'pong',
    name: 'Cloud Native Pong',
    component: 'pong',
    checks: ['pong-health', 'pong-homepage', 'pong-journey'],
    indicator: 'Successful external Pong health, homepage, and two-player journey observation',
  },
  {
    id: 'analytics',
    name: 'Analytics',
    component: 'analytics',
    checks: ['analytics-status', 'analytics-count'],
    indicator: 'Successful external HTTPS GET /status and same-origin /count requests',
  },
];

export const SLO_POLICY = {
  id: 'belacca-slo-99-v1',
  approved_by: 'Francesco Belacca',
  approved_at: '2026-08-08T23:12:00Z',
  target: SLO_TARGET,
  target_percent: '99%',
  window: '30d',
  window_hours: WINDOW_HOURS,
  cadence: '1h',
  unknown_policy: 'Missing, malformed, unclassified-failure, monitor-failure, and configuration-unknown slots are unknown, remain in coverage counts, and never count as success or bad target observations.',
  sla: false,
  service_credits: false,
  recovery_objective: {
    type: 'controlled_drill',
    target: 'under 6 minutes',
    excluded_from_availability_arithmetic: true,
    description: 'Controlled-drill recovery objective; it is not an availability measurement.',
  },
  description: 'Initial internal availability objective for each supported public application; no SLA or service credit is attached.',
};

const iso = (value) => new Date(value).toISOString();
const finiteDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const slotTime = (value) => Math.floor(Date.parse(value) / HOUR_MS) * HOUR_MS;
const rounded = (value) => Number(value.toFixed(6));

function sourceReferences(env, serviceID) {
  const workflow = env?.GITHUB_SERVER_URL && env?.GITHUB_REPOSITORY && env?.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : 'https://github.com/macel94/belacca-status/actions';
  return [
    workflow,
    `https://github.com/macel94/belacca-status/tree/main/history#${serviceID}`,
  ];
}

function validComponent(component) {
  return component
    && typeof component === 'object'
    && !Array.isArray(component)
    && typeof component.id === 'string'
    && component.id.length > 0
    && typeof component.raw_pass === 'boolean';
}

const HISTORY_OUTCOMES = new Set(['passed', 'target_failure', 'monitor_failure', 'configuration_unknown']);
const HISTORY_FAILURE_CLASSES = new Set(['none', 'target', 'monitor', 'configuration']);

function parseHistoryCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check) || typeof check.id !== 'string' || typeof check.passed !== 'boolean') return null;
  if (Object.hasOwn(check, 'duration_ms') && (!Number.isInteger(check.duration_ms) || check.duration_ms < 0 || check.duration_ms > 120000)) throw new Error('history check has invalid duration_ms');
  if (Object.hasOwn(check, 'outcome') && !HISTORY_OUTCOMES.has(check.outcome)) throw new Error('history check has invalid outcome');
  if (Object.hasOwn(check, 'failure_class') && !HISTORY_FAILURE_CLASSES.has(check.failure_class)) throw new Error('history check has invalid failure_class');
  if (Object.hasOwn(check, 'outcome') && Object.hasOwn(check, 'failure_class')) {
    const expectedClass = { passed: 'none', target_failure: 'target', monitor_failure: 'monitor', configuration_unknown: 'configuration' }[check.outcome];
    if (check.failure_class !== expectedClass || (check.outcome === 'passed') !== check.passed) throw new Error('history check outcome is inconsistent');
  }
  return {
    id: check.id,
    passed: check.passed,
    ...(Object.hasOwn(check, 'duration_ms') ? { duration_ms: check.duration_ms } : {}),
    ...(Object.hasOwn(check, 'outcome') ? { outcome: check.outcome } : {}),
    ...(Object.hasOwn(check, 'failure_class') ? { failure_class: check.failure_class } : {}),
  };
}

export function parseHistoryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('history record must be an object');
  if (value.schema_version !== 'belacca.observation.v1') throw new Error('unsupported history schema_version');
  if (!finiteDate(value.observed_at)) throw new Error('history record has an invalid observed_at');
  if (!Array.isArray(value.components) || value.components.length === 0) throw new Error('history record has no components');
  if (!value.components.every(validComponent)) throw new Error('history record has invalid components');
  if (new Set(value.components.map((component) => component.id)).size !== value.components.length) throw new Error('history record has duplicate components');
  return {
    schema_version: 'belacca.observation.v1',
    observed_at: new Date(value.observed_at).toISOString(),
    checks: Array.isArray(value.checks)
      ? value.checks.map(parseHistoryCheck).filter(Boolean)
      : [],
    components: value.components.map((component) => ({
      id: component.id,
      raw_pass: component.raw_pass,
    })),
  };
}

function filenameTimestamp(name) {
  const match = /^(\d{8})T(\d{6})(\d{3})?Z(?:-|$)/u.exec(name);
  if (!match) return null;
  const [, date, time, milliseconds = '000'] = match;
  const value = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.${milliseconds}Z`);
  return Number.isFinite(value) ? value : null;
}

function invalidEntryTimestamp(value, name) {
  return value && typeof value === 'object' && !Array.isArray(value) && finiteDate(value.observed_at)
    ? Date.parse(value.observed_at)
    : filenameTimestamp(name);
}

export async function readHistoryDirectory(historyDir) {
  let entries = [];
  try {
    entries = await readdir(historyDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], invalid_records: 0, invalid_timestamps: [] };
    throw error;
  }

  const records = [];
  let invalidRecords = 0;
  const invalidTimestamps = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let value;
    try {
      value = JSON.parse(await readFile(join(historyDir, entry.name), 'utf8'));
      records.push(parseHistoryRecord(value));
    } catch {
      invalidRecords += 1;
      const timestamp = invalidEntryTimestamp(value, entry.name);
      if (timestamp !== null) invalidTimestamps.push(timestamp);
    }
  }
  return { records, invalid_records: invalidRecords, invalid_timestamps: invalidTimestamps };
}

function latestRecord(records) {
  return records.reduce((latest, record) => {
    if (!latest || Date.parse(record.observed_at) > Date.parse(latest.observed_at)) return record;
    return latest;
  }, null);
}

function earliestRecord(records) {
  return records.reduce((earliest, record) => {
    if (!earliest || Date.parse(record.observed_at) < Date.parse(earliest.observed_at)) return record;
    return earliest;
  }, null);
}

function latestEvidenceTimestamp(records, invalidTimestamps, fallback) {
  const validTimestamp = latestRecord(records) ? Date.parse(latestRecord(records).observed_at) : null;
  const timestamps = [validTimestamp, ...invalidTimestamps].filter((timestamp) => Number.isFinite(timestamp));
  return timestamps.length > 0 ? Math.max(...timestamps) : fallback;
}

function serviceValue(record, service) {
  const component = record.components.find((item) => item.id === service.component);
  if (!component) return null;
  const checks = new Map(record.checks.map((check) => [check.id, check]));
  if (service.checks.some((checkID) => !checks.has(checkID))) return null;
  const targetFailure = service.checks.some((checkID) => checks.get(checkID).outcome === 'target_failure');
  const measurementFailure = service.checks.some((checkID) => ['monitor_failure', 'configuration_unknown'].includes(checks.get(checkID).outcome));
  const unclassifiedFailure = service.checks.some((checkID) => checks.get(checkID).passed === false && !checks.get(checkID).outcome);
  // A pure monitor/configuration/unclassified failure says the observation
  // could not measure the target. It is unknown, not a target outage, and must
  // not consume budget. If an independent target failure is present in the
  // same observation, keep that slot bad rather than hiding it.
  if ((measurementFailure || unclassifiedFailure) && !targetFailure) return null;
  // raw_pass is the monitor's aggregate result and must remain authoritative:
  // hysteresis changes the displayed status, never the recorded probe outcome.
  return component.raw_pass === true && service.checks.every((checkID) => checks.get(checkID).passed === true);
}

function calculateService(service, records, invalidRecords, invalidTimestamps, evaluationEnd, env) {
  const endSlot = slotTime(evaluationEnd);
  const startSlot = endSlot - (WINDOW_HOURS - 1) * HOUR_MS;
  const windowEnd = endSlot + HOUR_MS;
  const slots = new Map();
  const invalidSlots = new Set();
  let duplicateSlots = 0;
  let invalidRecordsInWindow = 0;

  for (const timestamp of invalidTimestamps) {
    if (timestamp < startSlot || timestamp >= windowEnd) continue;
    invalidRecordsInWindow += 1;
    invalidSlots.add(Math.floor(timestamp / HOUR_MS) * HOUR_MS);
  }
  // An invalid entry without a usable timestamp cannot be proven to be outside
  // the evaluated window, so it conservatively keeps the window non-reportable.
  invalidRecordsInWindow += Math.max(0, invalidRecords - invalidTimestamps.length);

  for (const record of records) {
    const timestamp = Date.parse(record.observed_at);
    if (timestamp < startSlot || timestamp >= windowEnd) continue;
    const key = slotTime(record.observed_at);
    if (slots.has(key)) duplicateSlots += 1;
    const previous = slots.get(key);
    if (!previous || timestamp > previous.timestamp) {
      slots.set(key, { timestamp, value: serviceValue(record, service) });
    }
  }

  let goodSlots = 0;
  let badSlots = 0;
  let unknownSlots = 0;
  for (let index = 0; index < WINDOW_HOURS; index += 1) {
    const slotKey = startSlot + index * HOUR_MS;
    const slot = slots.get(slotKey);
    if (invalidSlots.has(slotKey) || !slot || slot.value === null) unknownSlots += 1;
    else if (slot.value) goodSlots += 1;
    else badSlots += 1;
  }

  const observedSlots = goodSlots + badSlots;
  const complete = unknownSlots === 0 && invalidRecordsInWindow === 0;
  const state = observedSlots === 0 ? 'not_configured' : complete ? 'reportable' : 'measured';
  const earliest = earliestRecord(records);
  const latest = latestRecord(records);
  const hasRollingHorizon = earliest && latest && Date.parse(latest.observed_at) - Date.parse(earliest.observed_at) >= (WINDOW_HOURS - 1) * HOUR_MS;
  const measurement_window = observedSlots > 0 && hasRollingHorizon ? 'rolling_30d' : 'available_history';
  // Before 30 days, report the measured level over the observations that exist.
  // Once the horizon is complete, the same calculation covers the last 720
  // hourly slots. Unknown slots remain visible through coverage_percent.
  const allowedBadSlots = observedSlots * (1 - SLO_TARGET);
  const errorBudget = observedSlots > 0
    ? {
        allowed_bad_slots: rounded(allowedBadSlots),
        consumed_bad_slots: badSlots,
        consumed_percent: rounded((badSlots / allowedBadSlots) * 100),
        remaining_bad_slots: rounded(Math.max(0, allowedBadSlots - badSlots)),
        remaining_percent: rounded(Math.max(0, (allowedBadSlots - badSlots) / allowedBadSlots) * 100),
      }
    : null;

  return {
    id: service.id,
    name: service.name,
    scope: 'public',
    state,
    measurement_window,
    target: SLO_TARGET,
    target_percent: '99%',
    window: '30d',
    cadence: '1h',
    indicator: service.indicator,
    evaluation_window: {
      start: iso(startSlot),
      end: iso(endSlot),
      expected_slots: WINDOW_HOURS,
    },
    counts: {
      expected_slots: WINDOW_HOURS,
      observed_slots: observedSlots,
      good_slots: goodSlots,
      bad_slots: badSlots,
      unknown_slots: unknownSlots,
      duplicate_slots: duplicateSlots,
      invalid_records: invalidRecordsInWindow,
    },
    coverage_percent: rounded((observedSlots / WINDOW_HOURS) * 100),
    sli_percent: observedSlots > 0 ? rounded((goodSlots / observedSlots) * 100) : null,
    error_budget: errorBudget,
    latest_evidence_timestamp: latestRecord(records)?.observed_at || null,
    source_references: sourceReferences(env, service.id),
  };
}

export function buildSloArtifact({ records = [], invalidRecords = 0, invalidTimestamps = [], now = Date.now(), env = process.env } = {}) {
  const parsedRecords = records.map(parseHistoryRecord);
  const fallbackEnd = Math.floor(now / HOUR_MS) * HOUR_MS;
  const evidenceTimestamp = latestEvidenceTimestamp(parsedRecords, invalidTimestamps, fallbackEnd);
  const evaluationEnd = iso(Math.floor(evidenceTimestamp / HOUR_MS) * HOUR_MS);
  const endSlot = slotTime(evaluationEnd);
  const windowStart = endSlot - (WINDOW_HOURS - 1) * HOUR_MS;
  const windowEnd = endSlot + HOUR_MS;
  const invalidRecordsInWindow = invalidTimestamps.filter((timestamp) => timestamp >= windowStart && timestamp < windowEnd).length
    + Math.max(0, invalidRecords - invalidTimestamps.length);
  const services = SERVICE_DEFINITIONS.map((service) => calculateService(service, parsedRecords, invalidRecords, invalidTimestamps, evaluationEnd, env));
  return {
    $schema: 'https://raw.githubusercontent.com/macel94/belacca-status/main/slo.schema.json',
    schema_version: 'belacca.slo-evidence.v1',
    sanitized: true,
    publication_state: 'published',
    generated_at: iso(endSlot),
    policy: SLO_POLICY,
    evaluation: {
      window_start: iso(windowStart),
      window_end: iso(endSlot),
      expected_slots: WINDOW_HOURS,
      cadence: '1h',
      source_history_schema: 'belacca.observation.v1',
      valid_records: parsedRecords.length,
      invalid_records: invalidRecordsInWindow,
    },
    services,
    source_references: sourceReferences(env, 'platform'),
    notes: [
      'This is sanitized SLO evidence for an internal 99% objective, not an SLA or service-credit commitment.',
      'The SLI is a sampled hourly external-observation proxy for availability; missing slots never count as success.',
      'SLO evidence is separate from public status, incident hysteresis, paging, and operator notification.',
      'The current measured level uses good observed slots divided by good plus bad observed slots; missing, malformed, unclassified-failure, monitor-failure, and configuration-unknown slots are shown as coverage context and never count as success or bad target observations.',
      'Before the evidence spans 30 days, the measurement window is available history; thereafter it is the latest rolling 30-day horizon.'
    ],
  };
}

export async function runSloEvidence({ historyDir = 'history', output = 'slo.json', now = Date.now(), env = process.env } = {}) {
  const history = await readHistoryDirectory(historyDir);
  const artifact = buildSloArtifact({ ...history, now, env });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
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
    const artifact = await runSloEvidence({
      historyDir: args['history-dir'] || 'history',
      output: args.output || 'slo.json',
    });
    console.log(`published SLO evidence for ${artifact.services.length} services through ${artifact.evaluation.window_end}`);
  } catch (error) {
    console.error(`SLO evidence failed: ${error.message}`);
    process.exitCode = 1;
  }
}
