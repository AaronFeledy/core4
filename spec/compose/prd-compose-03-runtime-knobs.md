# PRD: COMPOSE-03 — Per-container runtime knobs (the preserved tier)

## Introduction

This is the tier users actually hit when a service needs a knob Lando didn't anticipate: `restart`, `cap_add`, `privileged`, `ulimits`, `tmpfs`, `extra_hosts`, `shm_size`, and friends. Per §6.2 these carry **no provider-neutral planner semantics** — Lando takes no opinion, invents no abstraction. They get schema shapes (both Compose forms), ride `ServicePlan.extensions.compose`, are capability-checked per §5.5.1 so nothing is ever silently dropped, and are realized by the bundled Podman provider. The work is deliberately mechanical: shape → preserve → capability → realize, with the PRD-01 matrix as the key inventory.

## Source References

- [`spec/06-services.md`](../06-services.md) §6.2 — the normative knob list.
- [`spec/05-runtime-providers.md`](../05-runtime-providers.md) §5.5.1 — preserve + capability-check order, `composeSpec` capability, `CapabilityError`; §5.3/§5.4 provider planes.
- `plugins/provider-lando`, `plugins/provider-podman` — realization targets; libpod create-container mappings.
- `sdk/src/schema/landofile.ts`, `core/src/services/planner.ts` — shape and preserve seams.

## Goals

- Every §6.2 knob decodes in all its Compose forms and survives losslessly into `ServicePlan.extensions.compose`.
- A provider that cannot realize a used knob fails at planning with an actionable `CapabilityError` — never mid-start, never silently.
- The bundled Podman provider realizes the common knobs so the tier is real, not theoretical.

## User Stories

### US-473: Knob-tier shapes, lossless preservation, and capability check

**Description:** As a user, every §6.2 runtime knob decodes in each form Compose defines and is preserved losslessly into the service plan — and on a provider that cannot realize a knob I used, planning fails up front with a tagged error naming the knob, the service, and the provider (§5.5.1: nothing is silently dropped).

**Acceptance Criteria:**

- [ ] Shapes land in `ServiceConfig` for: `restart`, `cap_add`, `cap_drop`, `privileged`, `devices` (string and long forms), `ulimits` (integer and `{soft, hard}` forms), `sysctls` (map and list), `tmpfs` (string and list), `shm_size` (bytes value or unit string), `dns`/`dns_search`/`dns_opt` (string and list), `extra_hosts` (list and map), `init`, `stop_signal`, `stop_grace_period` (duration string), `security_opt`, `group_add`, `read_only`, `platform`, `pull_policy`, `logging` (`driver` + `options`), `gpus`, and `deploy.resources` (`limits`/`reservations`: `cpus`, `memory`, `pids`; `devices` per matrix disposition).
- [ ] Multi-form keys canonicalize to one long form (same rule as PRD-02 FR-1); byte/duration strings parse with remediation on invalid grammar.
- [ ] The planner copies canonicalized knobs into `ServicePlan.extensions.compose` with a round-trip test proving losslessness for every key; redaction paths are unaffected (no secrets in knob values by construction).
- [ ] Planning collects the set of preserved knobs in use per service and checks it against the selected provider's `composeSpec` capability declaration before any provider action (§1.2 plan-before-act).
- [ ] Providers declare knob support as part of the `composeSpec` capability surface; the declaration shape is published in `@lando/sdk` and covered by the provider contract suite.
- [ ] An unsupported knob yields a `CapabilityError` carrying `{ service, key, provider }` and remediation (drop the key, switch provider, or move under `providers.<id>` extension); rendered by the CLI failure formatter with the standard machine-output envelope.
- [ ] The test provider declares a partial knob set so both accept and reject paths are covered deterministically.
- [ ] Each key's matrix entry is `preserved`; `check:compose-coverage` green.
- [ ] Schema snapshot refreshed; `sdk/API_COMPATIBILITY.md` updated (additive).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-474: Podman realization of the common knobs

**Description:** As a user on the bundled Podman provider, the common knobs take real effect in the created container.

**Acceptance Criteria:**

- [ ] The Podman provider maps to libpod create-container fields: `restart`, `cap_add`/`cap_drop`, `privileged`, `devices`, `ulimits`, `sysctls`, `tmpfs`, `shm_size`, `dns`/`dns_search`/`dns_opt`, `extra_hosts`, `init`, `stop_signal`, `stop_grace_period`, `security_opt`, `group_add`, `read_only`, `platform`, `pull_policy`, and `deploy.resources` (`cpus`, `memory`, `pids`).
- [ ] `logging` and `gpus` are declared per actual Podman support on each host platform; anything undeclared is *excluded from the capability declaration* (so the US-473 capability check rejects it) rather than best-effort mapped.
- [ ] The provider's declared knob set exactly matches what the mapping implements — asserted by a test that diffs declaration against mapping table.
- [ ] Unit tests cover request-body construction per knob; live verification (container actually privileged, ulimit applied, host entry present) lands in the env-gated integration suite (`LANDO_TEST_PODMAN_SOCKET`), serial per repo convention.
- [ ] Windows named-pipe and Linux socket transports both exercised by the integration matrix where CI supports them.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: Preserve is lossless and canonical: what reaches `extensions.compose` is the long form, byte-equal across plan/replan.
- FR-2: Capability declaration, planner check, and provider mapping may never disagree; the declaration-vs-mapping diff test is the invariant.
- FR-3: No provider-neutral plan fields are added for knobs in this wave (§6.2: no Lando abstraction, no planner semantics).

## Non-Goals

- No Docker-provider realization (no bundled Docker provider in this wave).
- No `deploy` orchestration keys (rejected tier).
- No knob-specific Lando sugar keys.

## Success Metrics

- A service block using `privileged`, `ulimits`, `extra_hosts`, `tmpfs`, and `shm_size` plans and starts on Podman with all five observable in the running container (integration suite), and fails at planning on the test provider with the partial declaration.

## Open Questions

- Whether `deploy.resources` later graduates to a provider-neutral `resources:` plan field (tracked in the index; not this wave).
