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

test('incomplete rolling windows expose coverage but no numeric SLO or budget', () => {
  const artifact = buildSloArtifact({ records: [historyRecord(END)], now: END, env });
  for (const service of artifact.services) {
    assert.equal(service.state, 'insufficient_data');
    assert.equal(service.counts.unknown_slots, WINDOW_HOURS - 1);
    assert.equal(service.sli_percent, null);
    assert.equal(service.error_budget, null);
  }
  assert.equal(artifact.policy.sla, false);
  assert.equal(artifact.policy.service_credits, false);
  assert.equal(artifact.policy.recovery_objective.excluded_from_availability_arithmetic, true);
  validateSlo(artifact);
});

test('missing component slots are unknown only for the affected application', () => {
  const records = completeHistory();
  records.at(-1).components = records.at(-1).components.filter((component) => component.id !== 'analytics');
  const artifact = buildSloArtifact({ records, now: END, env });
  assert.equal(artifact.services.find((service) => service.id === 'portfolio').state, 'reportable');
  assert.equal(artifact.services.find((service) => service.id === 'pong').state, 'reportable');
  const analytics = artifact.services.find((service) => service.id === 'analytics');
  assert.equal(analytics.state, 'insufficient_data');
  assert.equal(analytics.counts.unknown_slots, 1);
  assert.equal(analytics.sli_percent, null);
  assert.equal(analytics.error_budget, null);
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

test('legacy analytics observations without the collector check remain unknown', () => {
  const records = completeHistory();
  records[records.length - 1] = historyRecord(END, { legacyAnalytics: true });
  const artifact = buildSloArtifact({ records, now: END, env });
  const analytics = artifact.services.find((service) => service.id === 'analytics');
  assert.equal(analytics.state, 'insufficient_data');
  assert.equal(analytics.counts.unknown_slots, 1);
  assert.equal(analytics.sli_percent, null);
});

test('malformed records inside an expected slot remain unknown', () => {
  const artifact = buildSloArtifact({
    records: completeHistory(),
    invalidRecords: 1,
    invalidTimestamps: [END - HOUR_MS],
    now: END,
    env,
  });
  for (const service of artifact.services) {
    assert.equal(service.state, 'insufficient_data');
    assert.equal(service.counts.invalid_records, 1);
    assert.equal(service.counts.unknown_slots, 1);
    assert.equal(service.sli_percent, null);
  }
});

test('malformed records without a location prevent numeric claims', () => {
  const artifact = buildSloArtifact({ records: completeHistory(), invalidRecords: 1, now: END, env });
  for (const service of artifact.services) {
    assert.equal(service.state, 'insufficient_data');
    assert.equal(service.sli_percent, null);
    assert.equal(service.error_budget, null);
    assert.equal(service.counts.invalid_records, 1);
  }
  assert.throws(() => parseHistoryRecord({ schema_version: 'other', observed_at: new Date(END).toISOString(), components: [] }), /schema_version/);
  assert.throws(() => parseHistoryRecord({ schema_version: 'belacca.observation.v1', observed_at: new Date(END).toISOString(), components: [{ id: 'portfolio', raw_pass: true }, { id: 'portfolio', raw_pass: false }] }), /duplicate/);
});

test('complete windows report the 99 percent objective and error budget', () => {
  const records = completeHistory();
  records[records.length - 1].components.find((component) => component.id === 'pong').raw_pass = false;
  records[records.length - 1].checks.find((check) => check.id === 'pong-journey').passed = false;
  const artifact = buildSloArtifact({ records, now: END, env });
  const portfolio = artifact.services.find((service) => service.id === 'portfolio');
  const pong = artifact.services.find((service) => service.id === 'pong');
  assert.equal(portfolio.state, 'reportable');
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
