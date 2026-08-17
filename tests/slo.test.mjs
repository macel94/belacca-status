import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSloArtifact, parseHistoryRecord, readHistoryDirectory, HOUR_MS, SLO_TARGET, WINDOW_HOURS } from '../scripts/slo-evidence.mjs';
import { validateSlo } from '../scripts/validate-slo.mjs';

const END = Date.parse('2026-08-08T19:00:00Z');
const env = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'macel94/belacca-status',
  GITHUB_RUN_ID: '123',
};

function historyRecord(time, values = {}) {
  return {
    schema_version: 'belacca.observation.v1',
    observation_id: `run-${time}`,
    observed_at: new Date(time).toISOString(),
    status: 'operational',
    critical_pass: true,
    checks: [
      { id: 'portfolio-health', passed: values.portfolio !== false },
      { id: 'portfolio-homepage', passed: values.portfolio !== false },
      { id: 'pong-health', passed: values.pong !== false },
      { id: 'pong-homepage', passed: values.pong !== false },
      { id: 'pong-journey', passed: values.pong !== false },
      ...(values.legacyAnalytics ? [{ id: 'analytics-status', passed: values.analytics !== false }] : [
        { id: 'analytics-status', passed: values.analytics !== false },
        { id: 'analytics-count', passed: values.analytics !== false },
      ]),
    ],
    components: ['portfolio', 'pong', 'analytics']
      .filter((id) => values.omit !== id)
      .map((id) => ({ id, status: values[id] === false ? 'incident' : 'operational', raw_pass: values[id] !== false })),
  };
}

function completeHistory(values = {}) {
  return Array.from({ length: WINDOW_HOURS }, (_, index) => historyRecord(END - (WINDOW_HOURS - 1 - index) * 60 * 60 * 1000, values));
}

test('incomplete rolling windows report the current measured level and coverage', () => {
  const artifact = buildSloArtifact({ records: [historyRecord(END)], now: END, env });
  for (const service of artifact.services) {
    assert.equal(service.state, 'measured');
    assert.equal(service.measurement_window, 'available_history');
    assert.equal(service.counts.unknown_slots, WINDOW_HOURS - 1);
    assert.equal(service.sli_percent, 100);
    assert.equal(service.error_budget.allowed_bad_slots, 0.01);
    assert.equal(service.error_budget.consumed_bad_slots, 0);
  }
  assert.equal(artifact.policy.sla, false);
  assert.equal(artifact.policy.service_credits, false);
  assert.equal(artifact.policy.recovery_objective.excluded_from_availability_arithmetic, true);
  validateSlo(artifact);
});

test('a service with no observations stays available-history while others use the rolling horizon', () => {
  const records = completeHistory();
  records.forEach((record) => { record.components = record.components.filter((component) => component.id !== 'analytics'); });
  const artifact = buildSloArtifact({ records, now: END, env });
  const analytics = artifact.services.find((service) => service.id === 'analytics');
  assert.equal(analytics.state, 'not_configured');
  assert.equal(analytics.measurement_window, 'available_history');
  assert.equal(analytics.sli_percent, null);
  assert.equal(analytics.error_budget, null);
  assert.equal(artifact.services.find((service) => service.id === 'portfolio').measurement_window, 'rolling_30d');
});

test('missing component slots are unknown only for the affected application', () => {
  const records = completeHistory();
  records.at(-1).components = records.at(-1).components.filter((component) => component.id !== 'analytics');
  const artifact = buildSloArtifact({ records, now: END, env });
  assert.equal(artifact.services.find((service) => service.id === 'portfolio').state, 'reportable');
  assert.equal(artifact.services.find((service) => service.id === 'pong').state, 'reportable');
  const analytics = artifact.services.find((service) => service.id === 'analytics');
  assert.equal(analytics.state, 'measured');
  assert.equal(analytics.measurement_window, 'rolling_30d');
  assert.equal(analytics.counts.unknown_slots, 1);
  assert.equal(analytics.sli_percent, 100);
  assert.equal(analytics.error_budget.allowed_bad_slots, 7.19);
});

test('malformed records outside the evaluated window do not poison a complete window', () => {
  const artifact = buildSloArtifact({
    records: completeHistory(),
    invalidRecords: 1,
    invalidTimestamps: [END - WINDOW_HOURS * HOUR_MS],
    now: END,
    env,
  });
  for (const service of artifact.services) {
    assert.equal(service.state, 'reportable');
    assert.equal(service.counts.invalid_records, 0);
    assert.equal(service.counts.unknown_slots, 0);
  }
  assert.equal(artifact.evaluation.invalid_records, 0);
});

test('newer malformed evidence advances the rolling window while retaining measured claims', () => {
  const artifact = buildSloArtifact({
    records: completeHistory(),
    invalidRecords: 1,
    invalidTimestamps: [END + HOUR_MS],
    now: END,
    env,
  });
  assert.equal(artifact.generated_at, new Date(END + HOUR_MS).toISOString());
  assert.equal(artifact.evaluation.invalid_records, 1);
  for (const service of artifact.services) {
    assert.equal(service.state, 'measured');
    assert.equal(service.measurement_window, 'rolling_30d');
    assert.equal(service.counts.invalid_records, 1);
    assert.equal(service.counts.unknown_slots, 1);
    assert.equal(service.sli_percent, 100);
    assert.equal(service.error_budget.allowed_bad_slots, 7.19);
  }
});

test('pure monitor failures remain unknown instead of consuming the target budget', () => {
  const records = completeHistory();
  const latest = records.at(-1);
  latest.components.find((component) => component.id === 'pong').raw_pass = false;
  const journey = latest.checks.find((check) => check.id === 'pong-journey');
  journey.passed = false;
  journey.outcome = 'monitor_failure';
  journey.failure_class = 'monitor';
  const artifact = buildSloArtifact({ records, now: END, env });
  const pong = artifact.services.find((service) => service.id === 'pong');
  assert.equal(pong.counts.good_slots, WINDOW_HOURS - 1);
  assert.equal(pong.counts.bad_slots, 0);
  assert.equal(pong.counts.unknown_slots, 1);
  assert.equal(pong.sli_percent, 100);
  validateSlo(artifact);
});

test('legacy failures without an outcome remain unknown', () => {
  const records = completeHistory();
  const latest = records.at(-1);
  latest.components.find((component) => component.id === 'pong').raw_pass = false;
  latest.checks.find((check) => check.id === 'pong-journey').passed = false;
  const artifact = buildSloArtifact({ records, now: END, env });
  const pong = artifact.services.find((service) => service.id === 'pong');
  assert.equal(pong.counts.good_slots, WINDOW_HOURS - 1);
  assert.equal(pong.counts.bad_slots, 0);
  assert.equal(pong.counts.unknown_slots, 1);
  assert.equal(pong.sli_percent, 100);
  validateSlo(artifact);
});

test('an independent target failure remains bad beside a monitor failure', () => {
  const records = completeHistory();
  const latest = records.at(-1);
  latest.components.find((component) => component.id === 'pong').raw_pass = false;
  const health = latest.checks.find((check) => check.id === 'pong-health');
  health.passed = false;
  health.outcome = 'target_failure';
  health.failure_class = 'target';
  const journey = latest.checks.find((check) => check.id === 'pong-journey');
  journey.passed = false;
  journey.outcome = 'monitor_failure';
  journey.failure_class = 'monitor';
  const artifact = buildSloArtifact({ records, now: END, env });
  const pong = artifact.services.find((service) => service.id === 'pong');
  assert.equal(pong.counts.good_slots, WINDOW_HOURS - 1);
  assert.equal(pong.counts.bad_slots, 1);
  assert.equal(pong.counts.unknown_slots, 0);
  assert.equal(pong.sli_percent, 99.861111);
  validateSlo(artifact);
});

test('raw component failures remain bad even when all configured checks are healthy', () => {
  const records = completeHistory();
  records.at(-1).components.find((component) => component.id === 'portfolio').raw_pass = false;
  const artifact = buildSloArtifact({ records, now: END, env });
  const portfolio = artifact.services.find((service) => service.id === 'portfolio');
  assert.equal(portfolio.state, 'reportable');
  assert.equal(portfolio.counts.good_slots, WINDOW_HOURS - 1);
  assert.equal(portfolio.counts.bad_slots, 1);
  assert.equal(portfolio.sli_percent, 99.861111);
});

test('legacy analytics observations without the collector check remain measured with visible coverage gap', () => {
  const records = completeHistory();
  records[records.length - 1] = historyRecord(END, { legacyAnalytics: true });
  const artifact = buildSloArtifact({ records, now: END, env });
  const analytics = artifact.services.find((service) => service.id === 'analytics');
  assert.equal(analytics.state, 'measured');
  assert.equal(analytics.measurement_window, 'rolling_30d');
  assert.equal(analytics.counts.unknown_slots, 1);
  assert.equal(analytics.sli_percent, 100);
});

test('malformed records inside an expected slot keep the measured level and expose coverage gap', () => {
  const artifact = buildSloArtifact({
    records: completeHistory(),
    invalidRecords: 1,
    invalidTimestamps: [END - HOUR_MS],
    now: END,
    env,
  });
  for (const service of artifact.services) {
    assert.equal(service.state, 'measured');
    assert.equal(service.measurement_window, 'rolling_30d');
    assert.equal(service.counts.invalid_records, 1);
    assert.equal(service.counts.unknown_slots, 1);
    assert.equal(service.sli_percent, 100);
    assert.equal(service.error_budget.allowed_bad_slots, 7.19);
  }
});

test('malformed records without a location retain observed numeric claims', () => {
  const artifact = buildSloArtifact({ records: completeHistory(), invalidRecords: 1, now: END, env });
  for (const service of artifact.services) {
    assert.equal(service.state, 'measured');
    assert.equal(service.measurement_window, 'rolling_30d');
    assert.equal(service.sli_percent, 100);
    assert.equal(service.error_budget.allowed_bad_slots, 7.2);
    assert.equal(service.counts.invalid_records, 1);
  }
  assert.throws(() => parseHistoryRecord({ schema_version: 'other', observed_at: new Date(END).toISOString(), components: [] }), /schema_version/);
  assert.throws(() => parseHistoryRecord({ schema_version: 'belacca.observation.v1', observed_at: new Date(END).toISOString(), components: [{ id: 'portfolio', raw_pass: true }, { id: 'portfolio', raw_pass: false }] }), /duplicate/);
});

test('history check latency and failure classes are validated and preserved', () => {
  const record = historyRecord(END);
  record.checks[0] = { id: 'analytics-status', passed: false, duration_ms: 321, outcome: 'target_failure', failure_class: 'target' };
  const parsed = parseHistoryRecord(record);
  assert.deepEqual(parsed.checks[0], record.checks[0]);
  assert.throws(() => parseHistoryRecord({ ...record, checks: [{ ...record.checks[0], duration_ms: 120001 }] }), /duration_ms/);
  assert.throws(() => parseHistoryRecord({ ...record, checks: [{ ...record.checks[0], outcome: 'secret-leaked' }] }), /outcome/);
  assert.throws(() => parseHistoryRecord({ ...record, checks: [{ ...record.checks[0], failure_class: 'raw-error' }] }), /failure_class/);
  assert.throws(() => parseHistoryRecord({ ...record, checks: [{ ...record.checks[0], passed: true }] }), /inconsistent/);
});

test('complete windows report the 99 percent objective and error budget', () => {
  const records = completeHistory();
  records[records.length - 1].components.find((component) => component.id === 'pong').raw_pass = false;
  const failedJourney = records[records.length - 1].checks.find((check) => check.id === 'pong-journey');
  failedJourney.passed = false;
  failedJourney.outcome = 'target_failure';
  failedJourney.failure_class = 'target';
  const artifact = buildSloArtifact({ records, now: END, env });
  const portfolio = artifact.services.find((service) => service.id === 'portfolio');
  const pong = artifact.services.find((service) => service.id === 'pong');
  assert.equal(portfolio.state, 'reportable');
  assert.equal(portfolio.measurement_window, 'rolling_30d');
  assert.equal(portfolio.sli_percent, 100);
  assert.equal(portfolio.error_budget.allowed_bad_slots, Number((WINDOW_HOURS * (1 - SLO_TARGET)).toFixed(6)));
  assert.equal(portfolio.error_budget.remaining_bad_slots, 7.2);
  assert.equal(pong.sli_percent, 99.861111);
  assert.equal(pong.error_budget.consumed_bad_slots, 1);
  assert.equal(pong.error_budget.remaining_bad_slots, 6.2);
  validateSlo(artifact);
});

test('history directory ignores malformed files while preserving their unknown count', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'belacca-slo-history-'));
  await writeFile(join(directory, 'valid.json'), JSON.stringify(historyRecord(END)));
  await writeFile(join(directory, 'malformed.json'), '{ not-json');
  await writeFile(join(directory, 'old-record.json'), JSON.stringify({
    observed_at: new Date(END - WINDOW_HOURS * HOUR_MS).toISOString(),
    components: [],
  }));
  const result = await readHistoryDirectory(directory);
  assert.equal(result.records.length, 1);
  assert.equal(result.invalid_records, 2);
  assert.deepEqual(result.invalid_timestamps, [END - WINDOW_HOURS * HOUR_MS]);
});

test('checked-in SLO artifact is strict and sanitized', async () => {
  const { readFile } = await import('node:fs/promises');
  const artifact = JSON.parse(await readFile(new URL('../slo.json', import.meta.url), 'utf8'));
  assert.equal(validateSlo(artifact), true);
  assert.doesNotMatch(JSON.stringify(artifact), /room IDs?|player names?|127\.0\.0\.1|response bodies?|cookies?|tokens?/i);
  const tampered = structuredClone(artifact);
  tampered.extra = true;
  assert.throws(() => validateSlo(tampered), /unexpected property/);
  const withoutSchema = structuredClone(artifact);
  delete withoutSchema.$schema;
  assert.throws(() => validateSlo(withoutSchema), /missing property/);
  const schemaViolation = structuredClone(artifact);
  schemaViolation.services[0].counts.good_slots = '720';
  assert.throws(() => validateSlo(schemaViolation), /JSON Schema validation/);
});
