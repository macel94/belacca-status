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
    indicator: 'Successful external analytics status and harmless collector observation',
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
  unknown_policy: 'Missing or malformed observation slots are unknown and prevent a numeric SLO claim.',
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
      ? value.checks
        .filter((check) => check && typeof check.id === 'string' && typeof check.passed === 'boolean')
        .map((check) => ({ id: check.id, passed: check.passed }))
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

function serviceValue(record, service) {
  const component = record.components.find((item) => item.id === service.component);
  if (!component) return null;
  const checks = new Map(record.checks.map((check) => [check.id, check.passed]));
  if (service.checks.some((checkID) => !checks.has(checkID))) return null;
  return service.checks.every((checkID) => checks.get(checkID) === true);
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
  const state = observedSlots === 0
    ? 'not_configured'
    : complete
      ? 'reportable'
      : 'insufficient_data';
  const reportable = state === 'reportable';
  const allowedBadSlots = WINDOW_HOURS * (1 - SLO_TARGET);
  const errorBudget = reportable
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
    sli_percent: reportable ? rounded((goodSlots / WINDOW_HOURS) * 100) : null,
    error_budget: errorBudget,
    latest_evidence_timestamp: latestRecord(records)?.observed_at || null,
    source_references: sourceReferences(env, service.id),
  };
}

export function buildSloArtifact({ records = [], invalidRecords = 0, invalidTimestamps = [], now = Date.now(), env = process.env } = {}) {
  const parsedRecords = records.map(parseHistoryRecord);
  const latest = latestRecord(parsedRecords);
  const evaluationEnd = latest?.observed_at || iso(Math.floor(now / HOUR_MS) * HOUR_MS);
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
      'Numeric SLO and error-budget values appear only for complete, valid rolling windows.',
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
