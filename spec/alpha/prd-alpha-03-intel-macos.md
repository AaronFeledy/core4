# PRD: Alpha-03: Intel macOS

## Introduction

Intel macOS (`darwin-x64`) is in the six-target set. Managed Podman (`provider-lando`) fail-closes there with tagged remediation. System Docker (`provider-docker`) is the live path. Docker is not the product default.

## Source References

- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.4 capabilities, §5.7 tagged provider errors, §5.8 bundled providers
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 `lando setup`

## User Stories

### US-594: Intel macOS: provider-lando fail-closed; provider-docker live

**Description:** As a user on Intel macOS (`darwin-x64`), provider-lando rejects with a tagged error and remediation, and provider-docker is the live path.

**Acceptance Criteria:**

- [ ] On `darwin-x64`, selecting or defaulting to provider-lando fails closed with a `Schema.TaggedError` (machine `_tag`) and human remediation that names `lando setup --provider=docker` and/or `LANDO_PROVIDER=docker`.
- [ ] provider-docker on `darwin-x64` runs live setup, doctor, and app start against working system Docker.
- [ ] Other compile targets keep default provider `lando` (managed Podman). Docker is the Intel macOS live path, not the product default.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Silent fallback to Docker, a generic thrown exception, treating Docker as the global default, or compile-only `darwin-x64` smoke.

**Verification:** Live `darwin-x64` run where provider-lando rejects with tagged remediation. `lando setup --provider=docker` and `lando doctor` succeed. A trivial app starts.
