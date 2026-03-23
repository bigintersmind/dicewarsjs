---
name: build-check
description: Run full CI validation locally (format, lint, test, build) before pushing or creating a PR
disable-model-invocation: true
---

Run the full CI pipeline locally, mirroring the GitHub Actions CI workflow:

1. `npm run format:check` — verify all files are formatted correctly
2. `npm run lint` — check for lint errors (max 100 warnings allowed)
3. `npm test` — run all Jest tests
4. `npm run build` — verify production build succeeds

Report pass/fail for each step. If a step fails, stop and suggest fixes before continuing. Summarize the overall result at the end.
