# PRD: Alpha-01: Contract

## Introduction

This PRD is the public Alpha 1 contract. It sequences the wave. It does not own `spec/ROADMAP.md`. The only allowed spec-part edit is US-597's targeted change to `spec/08-cli-and-tooling.md` section 8.8.10 (Rails staged to bundled).

## Source References

- [`prd-alpha-00-index.md`](./prd-alpha-00-index.md) (order, non-goals, exit)
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.8 bundled providers
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.8 recipes
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 setup and doctor
- [`spec/13-testing-and-distribution.md`](../13-testing-and-distribution.md) §13.5 compile targets
- [`spec/15-binary-build-and-release.md`](../15-binary-build-and-release.md) §17 build pipeline (signing remains a non-goal here)

## User Stories

### US-592: Spec contract for public Alpha 1

**Description:** As a maintainer, `spec/alpha/` is the executable public Alpha 1 contract: current phase, six-target unsigned `4.0.0-dev.N` on `dev`, Intel macOS provider split, Drupal proven, Rails ordered contract-recipe-journey, and explicit non-goals, without ROADMAP ownership. The only allowed spec-part edit is US-597's targeted change to `spec/08-cli-and-tooling.md` section 8.8.10 (Rails staged to bundled).

**Acceptance Criteria:**

- [ ] `spec/alpha/` is the only Alpha 1 sequencing home; `spec/alpha-1/` does not exist.
- [ ] Public Alpha 1 is current. Historical internal phases are pre-alpha. Beta is later.
- [ ] Public artifacts are unsigned `4.0.0-dev.N` on the `dev` channel.
- [ ] The six compile targets are `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, and `windows-arm64`.
- [ ] On `darwin-x64`, provider-lando fail-closes with tagged remediation and provider-docker is the live path. Default provider stays `lando` on every other target.
- [ ] Drupal already exists and is proven in place. Rails order is contract, then `recipes/rails`, then the all-six journey. `recipes/` is public recipe SoT; any builtin rails stub is upgraded, not duplicated.
- [ ] Signing, installers, self-update, and 4.1 implementations are non-goals. This wave does not own or edit `spec/ROADMAP.md`.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** If this contract is missing, contradictory, claims ROADMAP ownership, or claims any spec-part rewrite beyond US-597's targeted section 8.8.10 Rails edit, US-593..US-600 must not start.

**Verification:** `prd.json` IDs US-592..US-600, unique priorities 1..9, all `passes: false`, established JSON keys only, no `dependsOn` field. Index and progress record the dependency graph.
