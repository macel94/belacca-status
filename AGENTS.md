# Agent instructions: belacca-status

This repository is an external evidence publisher, not a Flux deployment source. Read [`belacca-platform/docs/gitops-delivery.md`](https://github.com/macel94/belacca-platform/blob/main/docs/gitops-delivery.md) before changing status logic or interpreting generated commits.

## Delivery workflow

1. Edit policy/collector/validator code locally and run `npm test` plus `npm run check` as applicable.
2. Commit and push source changes to `main`.
3. Run or wait for `.github/workflows/publish-status.yml`.
4. The workflow validates and commits generated `status.json`, `history/`, `slo.json`, and `badge.json`; fetch that generated commit before claiming the public artifact is current.
5. Verify the public status/reliability surfaces and artifact freshness.

Status artifacts describe external observations. They are not a Kubernetes deployment source, do not replace Flux evidence, and do not prove a rollout. Credentials are out-of-band and must never be committed or written to generated history. Update the parent submodule pointer only when the workspace is intentionally being synchronized to this repository's latest published artifact commit.
