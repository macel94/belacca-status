# Authenticated operator probe runbook

This runbook is the operator follow-up for issue #2. It is intentionally
names-only: no credential, token, cookie, response body, or private dashboard
content belongs in this repository.

## Current state

The monitor has optional diagnostics for:

- `https://dashboard.belacca.com/` (`DASHBOARD_PROBE_BEARER_TOKEN`)
- `https://flux.belacca.com/` (`FLUX_PROBE_BEARER_TOKEN`)

The GitOps catalog currently describes the dashboard as Dex/Google protected
and backed by a shared Headlamp administrative ServiceAccount. It does not
prove that a dedicated least-privilege synthetic identity exists. Until the
identity provider and backend contract are reviewed, leave both GitHub Actions
secrets absent. Each absent secret is recorded as `configuration_unknown`, no
request is made, and no target incident is claimed.

## Safe enablement checklist

1. Obtain explicit operator/security approval for a dedicated synthetic
   identity. Do not reuse a human Google account, a cluster-admin token, a
   browser cookie, or a long-lived personal credential.
2. Verify that the identity provider supports a non-interactive, short-lived
   credential for the exact route. If it only supports an interactive Google
   login, leave the probe unknown rather than automating a human credential.
3. Grant only the read-only application capability needed to render the
   dashboard/Flux landing journey. In particular, do not grant Secret reads,
   resource mutation, cluster-admin, or access to private data not needed by
   the probe. Confirm the actual Headlamp backend authorization separately;
   the current shared ServiceAccount model may not satisfy this requirement.
4. Establish an out-of-band rotation and revocation procedure, an expiry
   shorter than the operational review period, and an owner. Record only the
   procedure and secret names, never values.
5. Store the short-lived bearer values in GitHub Actions secret storage under
   the exact names above. Do not put them in repository variables, workflow
   text, `.env` files, command-line arguments, test fixtures, or logs.
6. If a URL override is needed, set `DASHBOARD_PROBE_URL` or
   `FLUX_PROBE_URL` only in the runner environment to an HTTPS URL with no
   query, fragment, username, or password. The default URLs should be used for
   production.
7. Run the monitor manually and inspect only the sanitized check outcome,
   latency, and failure class. A successful HTML response is `passed`; a
   response that is not the authenticated page is `target_failure`; a timeout
   or transport/read exception is `monitor_failure`.
8. Confirm the committed `history/*.json` contains no response body, token,
   cookie, private URL, or raw exception. Revoke the credential immediately if
   any unexpected logging occurs.

## Failure-domain and incident handling

The GitHub-hosted runner is outside native production, so a failed target
request and a failed monitor runner are separate failure classes. The public
status aggregate and SLO remain based only on the catalogued public services;
operator probes are diagnostics and do not create an SLO denominator.
`configuration_unknown` means setup is absent or invalid and must be followed
up by an operator; it is not evidence that dashboard or Flux production is
down.

If the identity provider cannot safely support this journey, keep the secrets
absent and retain the unknown evidence. Do not weaken the check to accept an
OAuth redirect, scrape private content, or claim authenticated availability.
