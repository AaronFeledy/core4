# PRD: Alpha-04: Platform readiness

## Introduction

Every compile target must complete live `lando setup` and live `lando doctor`. Relocated-binary compile smoke does not close this PRD.

## Source References

- [`spec/11-subsystems.md`](../11-subsystems.md) §10.8 setup, §10.9 doctor
- [`prd-alpha-02-distribution.md`](./prd-alpha-02-distribution.md) six-target binaries
- [`prd-alpha-03-intel-macos.md`](./prd-alpha-03-intel-macos.md) darwin-x64 provider split

## User Stories

### US-595: Live lando setup and lando doctor on every compile target

**Description:** As a user, `lando setup` and `lando doctor` complete live on every compile target. Compile smoke is not enough.

**Acceptance Criteria:**

- [ ] Live `lando setup` succeeds on `linux-x64`, `linux-arm64`, `darwin-arm64`, `windows-x64`, and `windows-arm64` with default provider `lando`.
- [ ] Live `lando setup` succeeds on `darwin-x64` with `--provider=docker` (US-594).
- [ ] Live `lando doctor` succeeds on all six after setup, with no unresolved blocking checks.
- [ ] Compile-only, relocated-binary smoke, or unit tests do not satisfy this story.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Any target missing live setup or doctor evidence. Substituting compile smoke. Skipping `darwin-x64` or either Windows target.

**Verification:** Per-target evidence showing setup exit 0 and doctor exit 0 on all six compile targets.
