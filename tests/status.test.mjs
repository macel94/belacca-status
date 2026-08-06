import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArtifact, runMonitor } from '../scripts/monitor.mjs';
import { validateStatus } from '../scripts/validate-status.mjs';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const env = {
  PORTFOLIO_URL: 'https://francesco.belacca.com',
  PONG_URL: 'https://pong.belacca.com',
  ANALYTICS_URL: 'https://stats.belacca.com',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'macel94/belacca-status',
  GITHUB_RUN_ID: '123',
};

function checks({ portfolio = true, pong = true, analytics = true } = {}) {
  return [
    { id: 'portfolio-health', name: 'Portfolio health', critical: true, passed: portfolio, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/portfolio-health'] },
    { id: 'portfolio-homepage', name: 'Portfolio homepage', critical: true, passed: portfolio, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/portfolio-homepage'] },
    { id: 'pong-health', name: 'Pong health', critical: true, passed: pong, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/pong-health'] },
    { id: 'pong-homepage', name: 'Pong homepage', critical: true, passed: pong, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/pong-homepage'] },
    { id: 'pong-journey', name: 'Pong journey', critical: true, passed: pong, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/pong-journey'] },
    { id: 'analytics-status', name: 'Analytics status', critical: false, passed: analytics, duration_ms: 10, evidence_timestamp: new Date(NOW).toISOString(), source_references: ['https://example.test/analytics'] },
  ];
}

function historyRecord(time, values) {
  return {
    observed_at: new Date(time).toISOString(),
    critical_pass: values.portfolio !== false && values.pong !== false,
    components: [
      { id: 'portfolio', status: values.portfolio === false ? 'incident' : 'operational', raw_pass: values.portfolio !== false },
      { id: 'pong', status: values.pong === false ? 'incident' : 'operational', raw_pass: values.pong !== false },
      { id: 'analytics', status: values.analytics === false ? 'degraded' : 'operational', raw_pass: values.analytics !== false },
    ],
  };
}

test('first failure is degraded and repeated critical failure becomes incident', () => {
  const first = buildArtifact({ observationID: '1', observedAt: new Date(NOW).toISOString(), checks: checks({ pong: false }), history: [], env }).artifact;
  assert.equal(first.status, 'degraded');
  assert.equal(first.components.find((item) => item.id === 'pong').status, 'degraded');

  const second = buildArtifact({ observationID: '2', observedAt: new Date(NOW + 3600000).toISOString(), checks: checks({ pong: false }), history: [historyRecord(NOW, { pong: false })], env }).artifact;
  assert.equal(second.status, 'incident');
  assert.equal(second.components.find((item) => item.id === 'pong').status, 'incident');
  assert.equal(second.incidents[0].status, 'investigating');
});

test('non-critical failure remains degraded and critical recovery requires two successful observations', () => {
  const analyticsFailure = buildArtifact({ observationID: 'a1', observedAt: new Date(NOW).toISOString(), checks: checks({ analytics: false }), history: [], env }).artifact;
  assert.equal(analyticsFailure.status, 'degraded');
  assert.equal(analyticsFailure.components.find((item) => item.id === 'analytics').status, 'degraded');
});

test('incident recovery requires two successful observations and records resolution', () => {
  const incident = historyRecord(NOW, { pong: false });
  incident.components.find((item) => item.id === 'pong').incident_started_at = new Date(NOW - 3600000).toISOString();
  const firstRecovery = buildArtifact({ observationID: '3', observedAt: new Date(NOW + 3600000).toISOString(), checks: checks(), history: [incident, historyRecord(NOW, { pong: false })], env }).artifact;
  assert.equal(firstRecovery.status, 'incident');

  const recoveryPending = historyRecord(NOW + 3600000, {});
  recoveryPending.components.find((item) => item.id === 'pong').status = 'incident';
  const secondRecovery = buildArtifact({ observationID: '4', observedAt: new Date(NOW + 7200000).toISOString(), checks: checks(), history: [incident, historyRecord(NOW, { pong: false }), recoveryPending], env }).artifact;
  assert.equal(secondRecovery.status, 'operational');
  assert.equal(secondRecovery.incidents[0].status, 'resolved');
});

test('uptime stays unconfigured until 24 sanitized observations exist', () => {
  const history = Array.from({ length: 23 }, (_, index) => historyRecord(NOW - (23 - index) * 3600000, {}));
  const before = buildArtifact({ observationID: 'u1', observedAt: new Date(NOW).toISOString(), checks: checks(), history, env }).artifact;
  assert.equal(before.uptime.state, 'not_configured');
  const ready = buildArtifact({ observationID: 'u2', observedAt: new Date(NOW + 3600000).toISOString(), checks: checks(), history: [...history, historyRecord(NOW, {})], env }).artifact;
  assert.equal(ready.uptime.state, 'reported');
  assert.equal(ready.uptime.value, 100);
});

test('checked-in status artifact is valid for its publication state', async () => {
  const { readFile } = await import('node:fs/promises');
  const artifact = JSON.parse(await readFile(new URL('../status.json', import.meta.url), 'utf8'));
  assert.equal(validateStatus(artifact, { now: NOW }), true);
  assert.ok(['not_configured', 'published'].includes(artifact.publication_state));
  if (artifact.publication_state === 'not_configured') {
    assert.equal(artifact.status, 'unknown');
  } else {
    assert.ok(['operational', 'degraded', 'incident', 'unknown'].includes(artifact.status));
    assert.ok(artifact.observation_id);
  }
});

test('validation rejects expired artifacts and accepts a fresh generated artifact', () => {
  const artifact = buildArtifact({ observationID: 'v1', observedAt: new Date(NOW).toISOString(), checks: checks(), history: [], env }).artifact;
  assert.equal(validateStatus(artifact, { now: NOW }), true);
  assert.throws(() => validateStatus(artifact, { now: NOW + 3 * 3600000 }), /expired/);
});

test('runMonitor writes only sanitized status and history records', async () => {
  const { mkdtemp, readFile: read } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'belacca-status-'));
  const fetchImpl = async (url) => {
    const body = url.endsWith('/health') ? 'ok\n' : url.includes('stats') ? JSON.stringify({ version: 'test', uptime: '1h' }) : '<title>Cloud Native Pong</title><input id="playerName">Systems, under load.<div id="hero-title">';
    return new Response(body, { status: 200 });
  };
  const runProcessImpl = async () => ({ passed: true });
  const result = await runMonitor({ env: { ...env, STATUS_OBSERVATION_ID: 'test-run' }, fetchImpl, runProcessImpl, now: NOW, pongScript: '/tmp/pong.mjs', output: join(directory, 'status.json'), historyDir: join(directory, 'history') });
  validateStatus(result.artifact, { now: NOW });
  const raw = await read(join(directory, 'status.json'), 'utf8');
  assert.doesNotMatch(raw, /room|player|127\.0\.0\.1|response body/i);
  assert.match(result.artifact.source_references[0], /github\.com\/macel94\/belacca-status/);
});
