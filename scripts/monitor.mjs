import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const POLICY = {
  id: 'belacca-status-hourly-v1',
  approved_by: 'Francesco Belacca',
  approved_at: '2026-08-06T00:00:00Z',
  runner: 'GitHub-hosted Actions runner',
  interval: '1h',
  freshness_ttl: '2h',
  failure_threshold: 2,
  recovery_threshold: 2,
};

// Keep this list aligned with catalog/services.json. /count.js and operator
// journeys are supporting diagnostics and are deliberately not SLO inputs.
export const ANALYTICS_SLI_CHECKS = ['analytics-status', 'analytics-count'];
export const PORTFOLIO_ALIAS_HOSTS = ['belacca.com', 'www.belacca.com', 'www.francesco.belacca.com'];
export const PORTFOLIO_ALIAS_PATHS = ['/', '/reliability.html', '/status.html', '/privacy.html'];
const OPERATOR_PROBES = [
  {
    id: 'dashboard-authenticated',
    name: 'Authenticated dashboard journey',
    tokenEnv: 'DASHBOARD_PROBE_BEARER_TOKEN',
    urlEnv: 'DASHBOARD_PROBE_URL',
    defaultURL: 'https://dashboard.belacca.com/',
    expected: 'authenticated dashboard response',
  },
  {
    id: 'flux-authenticated',
    name: 'Authenticated Flux journey',
    tokenEnv: 'FLUX_PROBE_BEARER_TOKEN',
    urlEnv: 'FLUX_PROBE_URL',
    defaultURL: 'https://flux.belacca.com/',
    expected: 'authenticated Flux response',
  },
];
const OUTCOMES = ['passed', 'target_failure', 'monitor_failure', 'configuration_unknown'];
const COMPONENTS = {
  portfolio: { name: 'Portfolio', critical: true, checks: ['portfolio-health', 'portfolio-homepage'] },
  pong: { name: 'Cloud Native Pong', critical: true, checks: ['pong-health', 'pong-homepage', 'pong-journey'] },
  analytics: { name: 'Analytics', critical: false, checks: ANALYTICS_SLI_CHECKS },
  operator: { name: 'Operator journeys', critical: false, checks: OPERATOR_PROBES.map((probe) => probe.id) },
};

const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CHECK_ATTEMPTS = 3;
const MAX_CHECK_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const PONG_TIMEOUT_MS = 100_000;
const UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

export class MonitorError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MonitorError';
  }
}

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function boundedInteger(raw, fallback, minimum, maximum) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function retryOptions(env) {
  return {
    attempts: boundedInteger(env.STATUS_CHECK_ATTEMPTS, DEFAULT_CHECK_ATTEMPTS, 1, MAX_CHECK_ATTEMPTS),
    retryDelayMs: boundedInteger(env.STATUS_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 0, MAX_RETRY_DELAY_MS),
  };
}

async function waitBeforeRetry(delayMs) {
  if (delayMs <= 0) return;
  await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new MonitorError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new MonitorError(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function safeID(value) {
  const normalized = String(value || 'manual').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 80);
  return normalized || 'manual';
}

function sourceReferences(env, componentID) {
  const workflow = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : 'https://github.com/macel94/belacca-status/actions';
  const references = [workflow, `https://github.com/macel94/belacca-status/tree/main/history#${componentID}`];
  if (componentID.startsWith('pong') && /^[0-9a-f]{40}$/u.test(env.PONG_COMMIT || '')) references.push(`https://github.com/macel94/cloudnativepong/commit/${env.PONG_COMMIT}`);
  return references;
}

async function readResponseBody(response, label) {
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) throw new MonitorError(`${label} response too large`);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError(`${label} response could not be read`);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function fetchCheck({ id, name, critical, url, condition, fetchImpl, timeoutMs, observedAt, env, attempts, retryDelayMs, redirect = 'follow', acceptResponse = (response) => response.ok, headers = {} }) {
  const started = Date.now();
  let passed = false;
  let failure = '';
  let outcome = 'target_failure';
  let failureClass = 'target';
  let attempt = 0;
  for (attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect,
        headers: {
          accept: 'application/json, text/plain, text/html;q=0.9',
          'user-agent': 'belacca-status-monitor/1',
          ...headers,
        },
        signal: controller.signal,
      });
      const body = await readResponseBody(response, name);
      passed = acceptResponse(response) && condition(body, response);
      if (passed) {
        outcome = 'passed';
        failureClass = 'none';
      } else {
        failure = 'response did not satisfy the configured check';
      }
    } catch (error) {
      outcome = 'monitor_failure';
      failureClass = 'monitor';
      failure = error?.name === 'AbortError' || controller.signal.aborted ? 'request timed out' : 'request failed';
    } finally {
      clearTimeout(timer);
    }
    if (passed || attempt === attempts) break;
    await waitBeforeRetry(retryDelayMs * attempt);
  }
  const attemptLabel = `${attempt} attempt${attempt === 1 ? '' : 's'}`;
  return {
    id,
    name,
    critical,
    passed,
    outcome,
    failure_class: failureClass,
    duration_ms: Math.min(Date.now() - started, 120_000),
    evidence_timestamp: observedAt,
    summary: passed ? `External check passed${attempt > 1 ? ` after ${attemptLabel}` : ''}.` : `External check failed after ${attemptLabel}: ${failure || 'check condition failed'}.`,
    source_references: sourceReferences(env, id),
  };
}

function configurationUnknown({ id, name, critical, observedAt, env, reason }) {
  return {
    id,
    name,
    critical,
    passed: false,
    outcome: 'configuration_unknown',
    failure_class: 'configuration',
    duration_ms: 0,
    evidence_timestamp: observedAt,
    summary: `External check is not configured: ${reason}.`,
    source_references: sourceReferences(env, id),
  };
}

function runProcess(command, args, { env, timeoutMs }) {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      finish({ passed: false, failure: 'synthetic journey timed out' });
    }, timeoutMs);
    child.once('error', () => finish({ passed: false, failure: 'synthetic journey could not start' }));
    child.once('exit', (code, signal) => {
      if (code === 0) finish({ passed: true, failure: '' });
      else finish({ passed: false, failure: signal ? 'synthetic journey was terminated' : 'synthetic journey failed' });
    });
  });
}

async function runPongJourney({ script, baseURL, env, observedAt, runProcessImpl = runProcess, attempts, retryDelayMs }) {
  const started = Date.now();
  let result;
  let attempt = 0;
  for (attempt = 1; attempt <= attempts; attempt += 1) {
    const { DASHBOARD_PROBE_BEARER_TOKEN, FLUX_PROBE_BEARER_TOKEN, ...syntheticEnv } = env;
    result = await runProcessImpl(process.execPath, [resolve(script)], {
      env: { ...syntheticEnv, SYNTHETIC_BASE_URL: baseURL, SYNTHETIC_TIMEOUT_MS: '20000', SYNTHETIC_REQUEST_TIMEOUT_MS: '8000' },
      timeoutMs: PONG_TIMEOUT_MS,
    });
    if (result.passed === true || attempt === attempts) break;
    await waitBeforeRetry(retryDelayMs * attempt);
  }
  const attemptLabel = `${attempt} attempt${attempt === 1 ? '' : 's'}`;
  return {
    id: 'pong-journey',
    name: 'Pong two-player journey',
    critical: true,
    passed: result.passed === true,
    outcome: result.passed === true ? 'passed' : (result.failure?.includes('synthetic journey') ? 'monitor_failure' : 'target_failure'),
    failure_class: result.passed === true ? 'none' : (result.failure?.includes('synthetic journey') ? 'monitor' : 'target'),
    duration_ms: Math.min(Date.now() - started, 120_000),
    evidence_timestamp: observedAt,
    summary: result.passed === true
      ? `External two-player WebSocket journey passed${attempt > 1 ? ` after ${attemptLabel}` : ''}.`
      : `External two-player WebSocket journey failed after ${attemptLabel}: ${result.failure}.`,
    source_references: sourceReferences(env, 'pong-journey'),
  };
}

export function buildCheckDefinitions(env) {
  const portfolio = (env.PORTFOLIO_URL || 'https://francesco.belacca.com').replace(/\/$/u, '');
  const pong = (env.PONG_URL || 'https://pong.belacca.com').replace(/\/$/u, '');
  const analytics = (env.ANALYTICS_URL || 'https://stats.belacca.com').replace(/\/$/u, '');
  const aliases = PORTFOLIO_ALIAS_HOSTS.flatMap((host) => PORTFOLIO_ALIAS_PATHS.map((path) => ({
    host,
    path,
    location: `https://francesco.belacca.com${path}`,
  })));
  return [
    ...aliases.map(({ host, path, location }) => ({
      id: path === '/reliability.html'
        ? `portfolio-redirect-${host.replaceAll('.', '-')}`
        : `portfolio-redirect-${host.replaceAll('.', '-')}-${path === '/' ? 'root' : path.slice(1).replaceAll(/[^A-Za-z0-9]+/gu, '-')}`,
      name: `Portfolio redirect ${host}${path}`,
      critical: false,
      url: `https://${host}${path}`,
      redirect: 'manual',
      acceptResponse: (response) => response.status === 301 || response.status === 308,
      condition: (_body, response) => response.headers.get('location') === location,
    })),
    {
      id: 'portfolio-health', name: 'Portfolio health', critical: true, url: `${portfolio}/health`,
      condition: (body) => body.trim() === 'ok',
    },
    {
      id: 'portfolio-homepage', name: 'Portfolio homepage', critical: true, url: `${portfolio}/`,
      condition: (body) => body.includes('Systems, under load.') && body.includes('id="hero-title"'),
    },
    {
      id: 'pong-health', name: 'Pong health', critical: true, url: `${pong}/health`,
      condition: (body) => body.trim() === 'ok',
    },
    {
      id: 'pong-homepage', name: 'Pong homepage', critical: true, url: `${pong}/`,
      condition: (body) => body.includes('Cloud Native Pong') && body.includes('id="playerName"'),
    },
    {
      id: 'analytics-status', name: 'Analytics status', critical: false, url: `${analytics}/status`,
      condition: (body) => {
        try {
          const data = JSON.parse(body);
          return data && typeof data === 'object' && typeof data.version === 'string' && typeof data.uptime === 'string';
        } catch {
          return false;
        }
      },
    },
    {
      id: 'analytics-count', name: 'Analytics collector', critical: false, url: `${analytics}/count?p=%2Fsre-probe&t=Belacca%20SRE%20probe`,
      condition: (_body, response) => response.ok && response.headers.get('content-type')?.toLowerCase().includes('image/gif'),
    },
    {
      id: 'analytics-count-js', name: 'Analytics collector script', critical: false, url: `${analytics}/count.js`,
      condition: (body, response) => response.ok && response.headers.get('content-type')?.toLowerCase().includes('javascript') && body.includes('goatcounter'),
    },
  ];
}

function buildOperatorProbeDefinitions(env, observedAt) {
  return OPERATOR_PROBES.map((probe) => {
    const token = typeof env[probe.tokenEnv] === 'string' ? env[probe.tokenEnv].trim() : '';
    const url = typeof env[probe.urlEnv] === 'string' && env[probe.urlEnv].trim() ? env[probe.urlEnv].trim() : probe.defaultURL;
    let validURL = false;
    try {
      const parsed = new URL(url);
      validURL = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch {
      validURL = false;
    }
    if (!token) return configurationUnknown({ id: probe.id, name: probe.name, critical: false, observedAt, env, reason: `${probe.tokenEnv} is absent` });
    if (!validURL) return configurationUnknown({ id: probe.id, name: probe.name, critical: false, observedAt, env, reason: `${probe.urlEnv} must be an HTTPS origin-only URL` });
    return {
      id: probe.id,
      name: probe.name,
      critical: false,
      url,
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      acceptResponse: (response) => response.status >= 200 && response.status < 300 && response.headers.get('content-type')?.toLowerCase().includes('text/html'),
      condition: (body) => !/(?:oauth2\/start|sign[ -]?in|log[ -]?in)/iu.test(body),
    };
  });
}

async function observe({ env = process.env, fetchImpl = globalThis.fetch, runProcessImpl = runProcess, now = Date.now(), pongScript }) {
  if (typeof fetchImpl !== 'function') throw new MonitorError('fetch is not available');
  if (!pongScript) throw new MonitorError('pong synthetic script is required');
  const observedAt = iso(now);
  const checks = [];
  const { attempts, retryDelayMs } = retryOptions(env);
  for (const definition of buildCheckDefinitions(env)) {
    checks.push(await fetchCheck({ ...definition, fetchImpl, timeoutMs: Number(env.STATUS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, observedAt, env, attempts, retryDelayMs, redirect: definition.redirect, acceptResponse: definition.acceptResponse }));
    if (definition.id === 'pong-homepage') {
      checks.push(await runPongJourney({
        script: pongScript,
        baseURL: (env.PONG_URL || 'https://pong.belacca.com').replace(/\/$/u, ''),
        env,
        observedAt,
        runProcessImpl,
        attempts,
        retryDelayMs,
      }));
    }
  }
  for (const definition of buildOperatorProbeDefinitions(env, observedAt)) {
    checks.push(definition.outcome
      ? definition
      : await fetchCheck({ ...definition, fetchImpl, timeoutMs: Number(env.STATUS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, observedAt, env, attempts, retryDelayMs, redirect: definition.redirect, acceptResponse: definition.acceptResponse }));
  }
  return { observedAt, checks };
}

async function listHistory(historyDir) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path);
    }
  }
  await walk(historyDir);
  const records = [];
  for (const file of files.sort()) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value && typeof value.observed_at === 'string' && value.components) records.push(value);
    } catch {
      // Ignore a malformed historical file; the new observation is still safe.
    }
  }
  return records.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
}

function previousConsecutive(records, componentID, field, expected = true) {
  let count = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const component = records[index].components?.find((item) => item.id === componentID);
    if (!component || component[field] !== expected) break;
    count += 1;
  }
  return count;
}

function previousStatus(records, componentID) {
  return records.at(-1)?.components?.find((item) => item.id === componentID)?.status || 'operational';
}

function previousIncidentStart(records, componentID, fallback) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const component = records[index].components?.find((item) => item.id === componentID);
    if (component?.incident_started_at) return component.incident_started_at;
    if (component && component.status !== 'incident') break;
  }
  return fallback;
}

function deriveComponents(checks, history) {
  return Object.entries(COMPONENTS)
    .filter(([, definition]) => definition.checks.some((checkID) => checks.some((check) => check.id === checkID)))
    .map(([id, definition]) => {
    const componentChecks = definition.checks.map((checkID) => checks.find((check) => check.id === checkID)).filter(Boolean);
    const passed = componentChecks.length === definition.checks.length && componentChecks.every((check) => check.passed);
    const failed = componentChecks.some((check) => !check.passed);
    const unknownOnly = componentChecks.some((check) => check.outcome === 'configuration_unknown')
      && !componentChecks.some((check) => !check.passed && check.outcome !== 'configuration_unknown');
    const failures = failed ? previousConsecutive(history, id, 'raw_pass', false) + 1 : 0;
    const successes = passed ? previousConsecutive(history, id, 'raw_pass', true) + 1 : 0;
    const prior = previousStatus(history, id);
    let status = 'operational';
    if (unknownOnly) status = 'unknown';
    else if (failed) status = definition.critical && failures >= POLICY.failure_threshold ? 'incident' : 'degraded';
    else if (prior === 'incident' && successes < POLICY.recovery_threshold) status = 'incident';
    else if (prior === 'degraded' && successes < POLICY.recovery_threshold) status = 'degraded';
    const failedCount = componentChecks.filter((check) => !check.passed).length;
    const summary = status === 'operational'
      ? 'All configured external checks passed.'
      : status === 'unknown'
        ? 'Authenticated operator checks are not configured.'
        : status === 'incident'
          ? `${failedCount} critical external check${failedCount === 1 ? '' : 's'} failed.`
          : 'An external check is not currently healthy; confirmation is pending.';
    const incidentStarted = status === 'incident' ? previousIncidentStart(history, id, componentChecks.find((check) => !check.passed)?.evidence_timestamp) : undefined;
    return {
      id,
      name: definition.name,
      critical: definition.critical,
      status,
      raw_pass: passed,
      incident_started_at: incidentStarted,
      summary,
      evidence_timestamp: componentChecks.at(-1)?.evidence_timestamp,
      duration_ms: Math.min(componentChecks.reduce((total, check) => total + check.duration_ms, 0), 120_000),
      source_references: [...new Set(componentChecks.flatMap((check) => check.source_references))].slice(0, 10),
    };
  });
}

function calculateAggregateStatus(components) {
  if (components.some((component) => component.critical && component.status === 'incident')) return 'incident';
  if (components.some((component) => component.status === 'incident' || component.status === 'degraded')) return 'degraded';
  return 'operational';
}

function calculateSummary(status, components) {
  if (status === 'operational') return 'All critical public checks are passing.';
  if (status === 'incident') return `${components.filter((component) => component.critical && component.status === 'incident').map((component) => component.name).join(', ')} has a confirmed external incident.`;
  return 'One or more public checks are degraded; confirmation or recovery is in progress.';
}

function calculateIncidents(components, history, observedAt, env) {
  const current = components.filter((component) => component.status === 'incident').map((component) => ({
    id: `incident-${component.id}`,
    status: 'investigating',
    summary: `${component.name} has failed the configured external checks.`,
    started_at: component.incident_started_at || observedAt,
    updated_at: observedAt,
    source_references: sourceReferences(env, component.id),
  }));
  const previous = history.at(-1)?.components || [];
  for (const component of components) {
    const old = previous.find((item) => item.id === component.id);
    if (old?.status === 'incident' && component.status !== 'incident' && !current.some((item) => item.id === `incident-${component.id}`)) {
      current.push({
        id: `incident-${component.id}`,
        status: 'resolved',
        summary: `${component.name} has recovered after the configured recovery threshold.`,
        started_at: old.incident_started_at || observedAt,
        updated_at: observedAt,
        source_references: sourceReferences(env, component.id),
      });
    }
  }
  return current;
}

function calculateUptime(history, observedAt, env) {
  const observedAtMs = Date.parse(observedAt);
  const from = observedAtMs - UPTIME_WINDOW_MS;
  const observations = history
    .filter((record) => {
      const timestamp = Date.parse(record.observed_at);
      return timestamp >= from && timestamp <= observedAtMs;
    })
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  if (observations.length === 0) return { state: 'not_configured', value: null, window: '24h', source_reference: null };
  const good = observations.filter((record) => record.critical_pass === true).length;
  const bad = observations.length - good;
  const completeWindow = observations.length >= 24
    && Date.parse(observations.at(-1).observed_at) - Date.parse(observations[0].observed_at) >= UPTIME_WINDOW_MS;
  return {
    state: 'reported',
    value: Number(((good / observations.length) * 100).toFixed(3)),
    window: completeWindow ? '24h' : 'available history / 24h',
    observations: observations.length,
    good_observations: good,
    bad_observations: bad,
    source_reference: sourceReferences(env, 'uptime')[0],
  };
}

function toHistoryRecord({ observationID, observedAt, checks, components, status }) {
  return {
    schema_version: 'belacca.observation.v1',
    observation_id: observationID,
    observed_at: observedAt,
    status,
    critical_pass: components.filter((component) => component.critical).every((component) => component.raw_pass),
    checks: checks.map((check) => ({
      id: check.id,
      passed: check.passed,
      duration_ms: Number.isInteger(check.duration_ms) ? Math.max(0, Math.min(check.duration_ms, 120_000)) : 0,
      outcome: OUTCOMES.includes(check.outcome) ? check.outcome : (check.passed ? 'passed' : 'target_failure'),
      failure_class: ['none', 'target', 'monitor', 'configuration'].includes(check.failure_class)
        ? check.failure_class
        : (check.passed ? 'none' : 'target'),
    })),
    components: components.map((component) => ({
      id: component.id,
      status: component.status,
      raw_pass: component.raw_pass,
      incident_started_at: component.incident_started_at,
    })),
  };
}

export function buildArtifact({ observationID, observedAt, checks, history, env = process.env }) {
  const components = deriveComponents(checks, history);
  const status = calculateAggregateStatus(components);
  const validUntil = iso(Date.parse(observedAt) + 2 * 60 * 60 * 1000);
  const artifactHistory = [...history, toHistoryRecord({ observationID, observedAt, checks, components, status })];
  const artifact = {
    $schema: 'https://raw.githubusercontent.com/macel94/belacca-status/main/status.schema.json',
    schema_version: 'belacca.public-status.v2',
    sanitized: true,
    publication_state: 'published',
    status,
    summary: calculateSummary(status, components),
    observation_id: observationID,
    observed_at: observedAt,
    updated_at: observedAt,
    evidence_timestamp: observedAt,
    valid_until: validUntil,
    publisher: {
      name: 'Belacca hourly status monitor',
      source_reference: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : 'https://github.com/macel94/belacca-status/actions',
    },
    monitoring_policy: { ...POLICY },
    uptime: calculateUptime(artifactHistory, observedAt, env),
    components: components.map(({ raw_pass, incident_started_at, ...component }) => component),
    incidents: calculateIncidents(components, history, observedAt, env),
    source_references: sourceReferences(env, 'platform'),
    notes: [
      'Automated external evidence published under a human-approved monitoring policy.',
      'This is an hourly observation from a GitHub-hosted runner, not multi-region monitoring.',
      'The status page is hosted in the same single-VM cluster and may be unavailable during a complete VM outage.',
    ],
  };
  return { artifact, historyRecord: artifactHistory.at(-1) };
}

export async function runMonitor({
  env = process.env,
  fetchImpl = globalThis.fetch,
  runProcessImpl = runProcess,
  now = Date.now(),
  pongScript,
  output = 'status.json',
  historyDir = 'history',
} = {}) {
  const observationID = safeID(env.STATUS_OBSERVATION_ID || `manual-${now}`);
  const observation = await observe({ env, fetchImpl, runProcessImpl, now, pongScript });
  const history = await listHistory(historyDir);
  const { artifact, historyRecord } = buildArtifact({ observationID, observedAt: observation.observedAt, checks: observation.checks, history, env });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(resolve(historyDir), { recursive: true });
  const historyPath = join(resolve(historyDir), `${observation.observedAt.replace(/[-:.]/gu, '').replace(/Z$/u, 'Z')}-${observationID}.json`);
  await writeFile(resolve(output), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(historyPath, `${JSON.stringify(historyRecord, null, 2)}\n`);
  return {
    artifact,
    historyRecord,
    failed: observation.checks.some((check) => check.outcome === 'target_failure' || check.outcome === 'monitor_failure'),
    configuration_unknown: observation.checks.some((check) => check.outcome === 'configuration_unknown'),
    historyPath: relative(process.cwd(), historyPath),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const args = parseArgs(argv);
    const result = await runMonitor({
      env,
      output: args.output || 'status.json',
      historyDir: args['history-dir'] || 'history',
      pongScript: args['pong-script'],
    });
    console.log(`published ${result.artifact.status} observation ${result.artifact.observation_id}`);
    return result.failed ? 1 : 0;
  } catch (error) {
    console.error(`status monitor failed: ${error instanceof MonitorError ? error.message : 'unexpected monitor error'}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main();
}
