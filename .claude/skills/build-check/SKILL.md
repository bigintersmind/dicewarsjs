---
name: build-check
description: Run full CI validation locally (format, lint, test, build) before pushing or creating a PR
disable-model-invocation: true
---

Run the full CI pipeline locally, mirroring the GitHub Actions CI workflow
(same steps and order as `.github/workflows/ci.yml`):

1. `npm run format:check` — verify all files are formatted correctly
2. `npm run lint` — check for lint errors (max 100 warnings allowed)
3. `npm run build` — verify production build succeeds
4. `npm run test:coverage` — run all Vitest tests with coverage
5. `npm run test:benchmark` — run the benchmark suite

Report pass/fail for each step. If a step fails, stop and suggest fixes before continuing. Summarize the overall result at the end.
