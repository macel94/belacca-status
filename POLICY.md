# Belacca public status policy

This repository publishes a sanitized, hourly observation of the public Belacca
platform. It is a demonstration of external evidence and Git-tracked status
history, not a multi-region monitoring service.

## Scope

The GitHub-hosted Actions runner checks the public endpoints from outside the
native cluster that hosts the platform:

- **Portfolio**: `https://francesco.belacca.com/health` and the homepage.
- **Pong**: `https://pong.belacca.com/health`, homepage, and the complete
  create/join/two-WebSocket/playing/cleanup journey from the Pong repository.
- **Analytics**: `https://stats.belacca.com/status`, the harmless same-origin `/count` collector probe, and `/count.js` script availability.
- **Portfolio redirects**: `belacca.com`, `www.belacca.com`, and `www.francesco.belacca.com` are checked over `/`, `/reliability.html`, `/status.html`, and `/privacy.html` as non-SLO routing diagnostics; each must return a permanent redirect to `https://francesco.belacca.com` with the requested path preserved.
- **Operator journeys**: optional authenticated HTTPS probes for `https://dashboard.belacca.com/` and `https://flux.belacca.com/` using out-of-band bearer credentials. Missing credentials are explicitly `configuration_unknown` and make no request.

Analytics `/status` and `/count` are the SLO-eligible checks. `/count.js`,
portfolio alias redirects, and operator journeys are supporting diagnostics and
do not create separate services or SLO denominators. The current identity
provider does not provide a verified dedicated least-privilege synthetic
identity, so the optional operator probes remain unconfigured until an
operator completes the follow-up in `OPERATOR-PROBE-RUNBOOK.md`. The complete supported-host inventory and canonicalization policy is maintained in the GitOps repository's
[`docs/SITES.md`](https://github.com/macel94/belacca-gitops/blob/main/docs/SITES.md).
The dashboard and Flux UI require operator-managed identity and credentials.

## Publication rules

- Runs are scheduled hourly and can be started manually.
- Each external check is retried up to three times with a short increasing delay; a failure is recorded only when all attempts fail.
- `operational` means all critical checks passed.
- `degraded` means a non-critical component failed.
- `incident` means a critical component failed.
- `unknown` means there is no valid, fresh observation; the page explains this as awaiting fresh evidence rather than showing an absent configuration.
- A failed check is still committed as a status artifact before the workflow
  exits unsuccessfully.
- The artifact expires two hours after observation. The website must treat an
  expired or malformed artifact as `unknown`.
- Published uptime is reported from valid good/bad critical observations in the recent 24-hour window. When the history is shorter than a complete 24-hour horizon, the artifact reports `available history / 24h` and the observed count; it does not manufacture a full-window claim.
- The published artifact contains no response bodies, room IDs, player names,
  addresses, tokens, cookies, internal hostnames, or raw exception messages. The
  collector probe uses only a fixed synthetic path/title and stores aggregate
  pass/fail results, never the generated request URL or response body.
- History stores only bounded latency, outcome (`passed`, `target_failure`,
  `monitor_failure`, or `configuration_unknown`), and failure class (`none`,
  `target`, `monitor`, or `configuration`). Credentials are used in memory only
  and are never passed to the Pong child process or written to logs/artifacts.

The policy itself is human-approved. Individual observations are automated and
are not represented as manually reviewed incidents.

## Internal availability objective

Each supported public application (portfolio, Pong, and analytics) has an
internal availability objective of 99% over a rolling 30-day window. The SLI is
an hourly external-observation proxy: a component's `raw_pass` value in
`history/*.json` is one good or bad slot. The resulting 30-day budget is 7.2
hourly slots. This objective is not an SLA and does not provide service credits.

The sanitized [`slo.json`](slo.json) artifact is generated from the durable
history records and is separate from `status.json`, public incident state, and
status hysteresis. The current measured level is `good observed slots / (good
observed slots + bad observed slots)`. Before the evidence spans 30 days, the
denominator is the observations already available; once it spans 30 days, the
calculation uses the latest 720 hourly slots. A missing hourly slot, a missing
component, or a malformed history record is unknown, remains in the coverage
counts, and never counts as success. The source history contract remains
`belacca.observation.v1`.

A controlled-drill recovery objective under six minutes is a separate
operational exercise. It is represented as policy context only and is excluded
from the availability arithmetic; recovery-drill duration is not a good, bad,
or unknown availability slot.

## Failure-domain boundary

The runner and Git history are outside the native cluster, so an outage can
still be recorded while the cluster is down. The status page is hosted by that
same cluster, however, so it cannot display the outage until the site recovers.
A second public host would be required for an outage banner during a complete
cluster failure. This repository intentionally documents that limitation rather than
implying independent multi-region monitoring.
