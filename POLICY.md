# Belacca public status policy

This repository publishes a sanitized, hourly observation of the public Belacca
platform. It is a demonstration of external evidence and Git-tracked status
history, not a multi-region monitoring service.

## Scope

The GitHub-hosted Actions runner checks the public endpoints from outside the
single VM that hosts the platform:

- **Portfolio**: `https://francesco.belacca.com/health` and the homepage.
- **Pong**: `https://pong.belacca.com/health`, homepage, and the complete
  create/join/two-WebSocket/playing/cleanup journey from the Pong repository.
- **Analytics**: `https://stats.belacca.com/status`.

The dashboard is intentionally not monitored publicly because it requires an
operator-managed identity and credentials.

## Publication rules

- Runs are scheduled hourly and can be started manually.
- `operational` means all critical checks passed.
- `degraded` means a non-critical component failed.
- `incident` means a critical component failed.
- `unknown` means there is no valid, fresh observation.
- A failed check is still committed as a status artifact before the workflow
  exits unsuccessfully.
- The artifact expires two hours after observation. The website must treat an
  expired or malformed artifact as `unknown`.
- Uptime is not reported until at least 24 hours of hourly history exists.
- The published artifact contains no response bodies, room IDs, player names,
  addresses, tokens, cookies, internal hostnames, or raw exception messages.

The policy itself is human-approved. Individual observations are automated and
are not represented as manually reviewed incidents.

## Failure-domain boundary

The runner and Git history are outside the VM, so an outage can still be
recorded while the cluster is down. The status page is hosted by that same
cluster, however, so it cannot display the outage until the site recovers. A
second public host would be required for an outage banner during a complete VM
failure. This repository intentionally documents that limitation rather than
implying independent multi-region monitoring.
