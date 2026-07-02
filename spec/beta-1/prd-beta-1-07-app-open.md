# PRD: BETA1-07 — `lando open` (`app:open`)

## Introduction

Beta 1 adds the app-open surface as the browser-facing companion to the host-proxy URL opener. Users need one command that resolves app URLs from the plan, opens the real host browser when possible, and degrades cleanly for agents, CI, SSH sessions, and containers.

`app:open` is intentionally narrow. It opens only URLs Lando already knows from `ServiceInfo` and route data. It does not invent targets, expand the scheme surface, or bypass the command registry. The same command must work through source dispatch, the compiled binary, library command operations, and in-container `lando open` forwarding through the host-proxy `runLando` channel.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2.5 `app open` target resolution, `--service`, `--route`, `--all`, `--print`, scheme allowlist, opener helper, headless degradation, `hostProxyAllowed: true`, bootstrap `app`, and `pre-open-url` / `post-open-url` events.
- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.3 `LandoCommandSpec.hostProxyAllowed` and `resultSchema`; §8.4.1 dual-dispatch parity; §8.11 machine-readable output.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.10 host-proxy `runLando` channel, host-proxy allowlist, retained host dispatcher, in-container shim, and `openUrl` scheme discipline.
- [`spec/06-services.md`](../06-services.md) §6.6 proxy route data and §6.10 `ServiceInfo` as the source for app info and route reporting.
- [`spec/09-embedding.md`](../09-embedding.md) §16.7 programmatic CLI operations shared by source dispatch, compiled dispatch, and embedding hosts.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `HostProxyService`, `ShellRunner`, and lifecycle-event scope rows for Open.
- [`core/AGENTS.md`](../../core/AGENTS.md) machine-output, renderer, redaction, and dual-dispatch boundary gates.

## Goals

- Add `app:open` with top-level `lando open` so users can open the primary app URL from resolved app plan data.
- Keep browser opening host-side through a small `ShellRunner` helper, with safe headless behavior that prints instead of failing.
- Make `--print` and `--format json` useful for agents and CI without causing surprise browser launches.
- Allow in-container `lando open` to forward to the host through `runLando` while the host dispatcher resolves against the retained runtime.
- Cover source dispatch, compiled dispatch, machine output, lifecycle events, and host-proxy behavior with tests.

## User Stories

### US-402: `app:open` command

**Description:** As a user, I can run `lando open` to open my app's primary route in the host browser, choose a service or route when needed, print targets for agents or CI, and get a tagged error with remediation when the app has no openable target.

**Acceptance Criteria:**

- [ ] `app:open` registers with top-level alias `lando open`, bootstrap level `app`, `hostProxyAllowed: true`, and a required `resultSchema` for resolved open targets.
- [ ] With no flags, target resolution opens the app's primary route: the first proxy route of the first service that declares one, preferring `https` per §8.2.5.
- [ ] `--service <name>` scopes target resolution to that service's routes or endpoints.
- [ ] `--route <host>` selects an exact route hostname from resolved route data.
- [ ] `--all` resolves every openable route and opens or prints each target in deterministic order.
- [ ] An app with no routes and no HTTP endpoints fails with `OpenTargetUnresolvedError`, includes what `app:info` knows about, and points remediation at `proxy:` config.
- [ ] Only `http` and `https` targets are opened; invariant violations fail with `HostProxyOpenUrlSchemeError` semantics.
- [ ] `--print` skips browser launch and prints the resolved URL list.
- [ ] Headless hosts or missing opener capability degrade to printing the URL with a note and exit 0.
- [ ] Browser launch uses the shared host-opener helper backed by `ShellRunner`, not direct process spawning in the command body.
- [ ] `--format json` returns the resolved target list through `encodeCommandResult`; `--json` follows the §8.2.5 no-launch behavior unless the spec's explicit TTY carve-out applies.
- [ ] `pre-open-url` and `post-open-url` events publish for every opened URL with redacted URL summaries.
- [ ] OCLIF dispatch and compiled `runCompiledCli` dispatch have parity tests for default resolution, `--service`, `--route`, `--all`, `--print`, headless degradation, and failure cases.
- [ ] Machine-output conformance covers success and failure envelopes for `app:open`.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-403: `app:open` host-proxy round-trip

**Description:** As a user inside a Lando service, I can type `lando open` and have the in-container shim forward the request to the host, where the retained runtime resolves the same app URL and opens or prints it with the same result shape as host-side invocation.

**Acceptance Criteria:**

- [ ] `app:open` is included in the generated host-proxy `runLando` allowlist through `hostProxyAllowed: true`.
- [ ] The in-container `lando` shim forwards `lando open` over the §10.10 `runLando` channel with cwd, tty, and filtered env.
- [ ] The host-side dispatcher remaps the container cwd to the host app root and resolves targets against the retained runtime, not by trusting container-provided URLs.
- [ ] Host-proxy invocation returns the same `CommandResultEnvelope` and exit-code semantics as host-side `app:open`.
- [ ] `--print` and headless degradation work the same through host-proxy dispatch as they do on the host.
- [ ] `HostProxyCommandNotAllowedError` is covered for a removed or stale allowlist entry, and the generated allowlist freshness gate catches drift.
- [ ] `pre-host-proxy-call` / `post-host-proxy-call` and `pre-open-url` / `post-open-url` events remain redacted; `bun run check:redaction-boundary` covers the payload paths.
- [ ] Contract-suite coverage exercises an in-container `lando open` round-trip through the test host-proxy dispatcher.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** `app:open` MUST resolve targets from the app plan, `ServiceInfo`, and route data; it MUST NOT invent or accept arbitrary user-provided URLs.
- **FR-2:** Default resolution MUST prefer the primary `https` route when present, then follow the §8.2.5 primary-route rule.
- **FR-3:** The only openable schemes for `app:open` are `http` and `https`.
- **FR-4:** Browser opening MUST go through the shared `ShellRunner` host-opener helper and degrade to print plus exit 0 when a host opener is unavailable.
- **FR-5:** `--print` and machine output MUST be agent-safe and schema-valid, with no unexpected browser launch outside the §8.2.5 TTY carve-out.
- **FR-6:** `app:open` MUST be `hostProxyAllowed: true` and work through in-container `runLando` forwarding with retained-runtime host resolution.
- **FR-7:** OCLIF and compiled dispatch paths MUST stay in parity for every `app:open` flag and failure mode.

## Non-Goals

- No arbitrary `lando open <url>` surface.
- No schemes beyond `http` and `https` for `app:open`.
- No provider discovery beyond the live endpoint state §8.2.5 allows for `--service`.
- No GUI launcher framework beyond the small shared host-opener helper.
- No changes to the host-proxy `openUrl` request surface beyond using the existing `runLando` path for in-container `lando open`.

## Technical Considerations

- Keep command logic in pure Effect and keep process launching behind `ShellRunner`; command bodies must not call platform opener commands directly.
- `--json` behavior has a specific no-launch default in §8.2.5. Tests should lock the exact relationship between TTY, explicit selection flags, and browser launch.
- Host-proxy `runLando` must resolve against host-side app state. Container-provided cwd is an app selector, not authority for targets.
- `pre-open-url` / `post-open-url` payloads should include only redacted URL summaries, not raw secret-bearing query strings.
- The result schema should represent targets and launch outcomes faithfully enough for `--print`, headless degradation, and multi-target `--all` without adding extra behavior beyond §8.2.5.

## Success Metrics

- `lando open --print` prints the same primary target that `app:info --deep` reports as the app's primary route.
- `lando open --format json` emits a schema-valid envelope in both source and compiled dispatch.
- A headless test host returns exit 0 and printed targets without attempting a browser launch.
- An in-container `lando open --print` round-trip returns the same target list as host-side `lando open --print`.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| `lando open` basic usage and `--print` | `docs/guides/cli/open-app.mdx` | Planned (new guide, this PRD) |
| In-container `lando open` host-proxy round-trip | owned by the host-proxy guide surface | Update and re-run drift gate |
| Machine-readable open targets | owned by the agent-native CLI output guide | Update and re-run drift gate |

## Open Questions

- What exact result fields should `app:open` expose for launch outcome versus resolved target? The spec requires a result schema and target list, but does not name the field shape.
- Should `--all` include service endpoints that are not proxy routes when proxy routes exist, or only every resolved proxy route? Follow §8.2.5 literally during implementation and amend the spec if endpoint inclusion needs more detail.
