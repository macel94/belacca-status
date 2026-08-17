# Belacca status

The canonical cross-repository GitOps delivery and commit-routing guide is
[`belacca-platform/docs/gitops-delivery.md`](https://github.com/macel94/belacca-platform/blob/main/docs/gitops-delivery.md).

[![Public status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmacel94%2Fbelacca-status%2Fmain%2Fbadge.json)](https://francesco.belacca.com/status.html)

Hourly, externally observed and sanitized status history for the Belacca
platform. The generated [`badge.json`](badge.json) is a reusable Shields
endpoint artifact derived from the fresh published status; it becomes grey
`unknown` when generated from an expired or bootstrap artifact.

The scheduled GitHub Actions runner checks public portfolio, Pong, and
analytics endpoints from outside the native cluster that hosts the platform. It
checks the catalogued analytics SLI (`/status` plus a fixed harmless same-origin
`/count` collector probe), `/count.js` as a supporting diagnostic, and every
supported portfolio alias over representative paths while preserving the path
in the expected canonical `Location`. It commits a public `status.json`
artifact and a bounded, sanitized observation record under `history/` every
hour. It also publishes [`slo.json`](slo.json), a sanitized
30-day SLO and error-budget artifact generated from that history, plus the
badge artifact. See [`POLICY.md`](POLICY.md) for the publication and
failure-domain boundary.

Each supported public application has an internal 99% availability objective;
this is not an SLA and carries no service credit. `slo.json` reports the current
measured level as `good observations / (good + bad observations)` using the
observations already available. It switches to the latest rolling 30-day slot
window once the history spans 30 days. Missing or malformed slots remain visible
as coverage context and never count as good. A controlled-drill recovery
objective under six minutes is separate policy context and is excluded from
availability arithmetic.

Authenticated dashboard and Flux checks are optional diagnostics. They use only
short-lived, operator-managed bearer credentials supplied as GitHub Actions
secrets (`DASHBOARD_PROBE_BEARER_TOKEN` and `FLUX_PROBE_BEARER_TOKEN`); values
are never written to Git, passed to the Pong child process, or included in
history. The probe makes no request when its credential is absent and records
`configuration_unknown`. The current Dex/Google deployment does not provide a
verified least-privilege synthetic identity, so operators must not populate
these secrets until one is approved and the endpoint accepts this probe safely.

The repository is intentionally not a Kubernetes status API or paging system.
The website reads the public `status.json` artifact from GitHub and then tries
its checked-in local copy if the external fetch is unavailable. Both paths are
validated; missing, malformed, or expired published evidence becomes a
freshness-safe unknown state. Published uptime is calculated from good and bad critical observations
in the recent 24-hour window; short history is labeled `available history / 24h`
with its observation count. `slo.json` is durable reliability evidence, not a
public uptime claim; its current measured levels are published immediately from
observed evidence, while coverage and measurement window are shown alongside
them.
The first reviewed commit is also used as the platform submodule pointer for
local workspace review.

## GitOps and generated publication commits

This repository is not a Flux deployment source. Source and policy changes are
committed and pushed to `main`, then `.github/workflows/publish-status.yml`
validates and publishes the generated `status.json`, `history/`, `slo.json`, and
`badge.json` artifacts in a follow-up commit. Fetch that generated commit before
claiming the public evidence is current. These artifacts describe external
observations; they do not deploy Kubernetes workloads or prove a rollout.

When this repository is checked out as part of `belacca-platform`, update the
parent submodule pointer only after the generated publication commit is on
`origin/main` and only when the workspace is intentionally being synchronized.
The complete cross-repository commit/push and Flux verification model is in the
workspace [`belacca-platform/docs/gitops-delivery.md`](https://github.com/macel94/belacca-platform/blob/main/docs/gitops-delivery.md).

## Local checks

```bash
npm test
npm run check
node scripts/slo-evidence.mjs --history-dir history --output slo.json
node scripts/badge.mjs --input status.json --output badge.json
node scripts/validate-slo.mjs slo.json
node scripts/validate-badge.mjs badge.json
```

The full Pong journey requires the sibling repository and its npm dependency:

```bash
npm --prefix ../cloudnativepong ci --ignore-scripts
node scripts/monitor.mjs \
  --pong-script ../cloudnativepong/scripts/synthetic-check.mjs
```

## Optional operator probe configuration

The workflow can receive these out-of-band secrets without changing public
artifacts:

- `DASHBOARD_PROBE_BEARER_TOKEN` for `https://dashboard.belacca.com/`
- `FLUX_PROBE_BEARER_TOKEN` for `https://flux.belacca.com/`

A supplied URL override must be HTTPS with no query, fragment, username, or
password. A successful HTML response that is not an OAuth sign-in page is
`passed`; a response mismatch is `target_failure`; a transport or monitor
exception is `monitor_failure`; and absent/invalid configuration is
`configuration_unknown`. Target and monitor failures make the monitor command
unsuccessful after the sanitized status, SLO, history, and badge artifacts have
been validated and pushed. This keeps the GitHub workflow badge red during a
confirmed target incident while still preserving the evidence needed by the
status page. Missing production-only identity setup remains explicitly
`configuration_unknown` and does not become a native target outage.

Before enabling either secret, an operator must create and approve a dedicated
least-privilege synthetic identity, document rotation/revocation, and verify
that the identity provider supports this bearer probe safely. That production
step cannot be performed or claimed from this repository.
