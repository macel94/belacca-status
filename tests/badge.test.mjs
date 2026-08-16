import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBadge } from '../scripts/badge.mjs';
import { validateBadge } from '../scripts/validate-badge.mjs';

const NOW = Date.parse('2026-08-16T12:00:00Z');

function status(state, validUntil = '2026-08-16T14:00:00Z') {
  return {
    $schema: 'https://raw.githubusercontent.com/macel94/belacca-status/main/status.schema.json',
    schema_version: 'belacca.public-status.v2',
    sanitized: true,
    publication_state: 'published',
    status: state,
    summary: 'test status',
    observation_id: 'test-run',
    observed_at: '2026-08-16T11:59:00Z',
    updated_at: '2026-08-16T11:59:00Z',
    evidence_timestamp: '2026-08-16T11:59:00Z',
    valid_until: validUntil,
    publisher: { name: 'test publisher', source_reference: 'https://github.com/macel94/belacca-status/actions/runs/1' },
    monitoring_policy: { id: 'policy', approved_by: 'Francesco Belacca', approved_at: '2026-08-01T00:00:00Z', runner: 'GitHub', interval: '1h', freshness_ttl: '2h', failure_threshold: 2, recovery_threshold: 2 },
    uptime: { state: 'not_configured', value: null, window: '24h', source_reference: null },
    components: [{ id: 'portfolio', name: 'Portfolio', critical: true, status: state, summary: 'test', evidence_timestamp: '2026-08-16T11:59:00Z', duration_ms: 1, source_references: ['https://example.test'] }],
    incidents: [],
    source_references: ['https://github.com/macel94/belacca-status/actions'],
    notes: [],
  };
}

test('badge mirrors each fresh published status with a safe color', () => {
  for (const [state, color] of [['operational', 'brightgreen'], ['degraded', 'orange'], ['incident', 'red']]) {
    const badge = buildBadge(status(state), { now: NOW });
    assert.equal(badge.status, state);
    assert.equal(badge.message, state);
    assert.equal(badge.color, color);
    assert.equal(badge.observedAt, '2026-08-16T11:59:00Z');
    validateBadge(badge);
  }
});

test('fresh unknown, expired, and bootstrap artifacts remain grey without live timestamps', () => {
  const freshUnknown = buildBadge(status('unknown'), { now: NOW });
  assert.equal(freshUnknown.status, 'unknown');
  assert.equal(freshUnknown.color, 'lightgrey');
  assert.equal(freshUnknown.observedAt, null);
  assert.equal(freshUnknown.validUntil, null);
  validateBadge(freshUnknown);


  const expired = buildBadge(status('operational', '2026-08-16T11:00:00Z'), { now: NOW });
  assert.equal(expired.status, 'unknown');
  assert.equal(expired.color, 'lightgrey');
  assert.equal(expired.observedAt, null);
  validateBadge(expired);

  const bootstrap = {
    ...status('unknown'),
    publication_state: 'not_configured',
    observation_id: null,
    observed_at: null,
    updated_at: null,
    evidence_timestamp: null,
    valid_until: null,
    publisher: { name: null, source_reference: null },
    monitoring_policy: null,
    components: [],
    incidents: [],
  };
  const badge = buildBadge(bootstrap, { now: NOW });
  assert.equal(badge.status, 'unknown');
  assert.equal(badge.validUntil, null);
  validateBadge(badge);
});
