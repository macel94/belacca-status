# Belacca status

Hourly, externally observed and sanitized status history for the Belacca
platform.

The scheduled GitHub Actions runner checks public portfolio, Pong, and
analytics endpoints from outside the single VM that hosts the platform. It
commits a public `status.json` artifact and a bounded, sanitized observation
record under `history/` every hour. See [`POLICY.md`](POLICY.md) for the
publication and failure-domain boundary.

The repository is intentionally not a Kubernetes status API. The website reads
the raw artifact from GitHub and falls back to its checked-in unknown state if
the artifact is missing, malformed, or expired. The first reviewed commit is
also used as the platform submodule pointer for local workspace review.

## Local checks

```bash
npm test
npm run check
```

The full Pong journey requires the sibling repository and its npm dependency:

```bash
npm --prefix ../cloudnativepong ci --ignore-scripts
node scripts/monitor.mjs \
  --pong-script ../cloudnativepong/scripts/synthetic-check.mjs
```
