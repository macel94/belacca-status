# Belacca status

Hourly, externally observed and sanitized status history for the Belacca
platform.

The scheduled GitHub Actions runner checks public portfolio, Pong, and
analytics endpoints from outside the native cluster that hosts the platform. It
checks the analytics `/status` endpoint and a fixed harmless `/count` collector
probe; portfolio aliases are checked as redirect diagnostics. It commits a
public `status.json` artifact and a bounded, sanitized observation record under
`history/` every hour. It also publishes [`slo.json`](slo.json), a sanitized
30-day SLO and error-budget artifact generated from that history. See
[`POLICY.md`](POLICY.md) for the publication and failure-domain boundary.

Each supported public application has an internal 99% availability objective;
this is not an SLA and carries no service credit. Missing or malformed hourly
slots keep SLO values unknown until the full 720-slot window is valid. A
controlled-drill recovery objective under six minutes is separate policy context
and is excluded from availability arithmetic.

Authenticated dashboard and Flux checks are intentionally not configured: they
would require an operator-managed identity and are not part of the public
artifact until a dedicated safe probe exists.

The repository is intentionally not a Kubernetes status API or paging system.
The website reads only the public `status.json` artifact from GitHub and falls
back to its checked-in unknown state if the artifact is missing, malformed, or
expired. `slo.json` is durable reliability evidence, not a public uptime claim;
its 99%/30d values remain non-reportable until the complete valid window exists.
The first reviewed commit is also used as the platform submodule pointer for
local workspace review.

## Local checks

```bash
npm test
npm run check
node scripts/slo-evidence.mjs --history-dir history --output slo.json
node scripts/validate-slo.mjs slo.json
```

The full Pong journey requires the sibling repository and its npm dependency:

```bash
npm --prefix ../cloudnativepong ci --ignore-scripts
node scripts/monitor.mjs \
  --pong-script ../cloudnativepong/scripts/synthetic-check.mjs
```
