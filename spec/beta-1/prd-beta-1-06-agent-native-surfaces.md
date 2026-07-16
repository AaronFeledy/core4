# PRD: BETA1-06 — Agent-native surfaces (`lando mcp` + agent-context env forwarding)

## Introduction

Beta 1 is the contract-completion phase plus the agent-native feature wave. The spec now names two connected surfaces that let agents use Lando without scraping prose or losing context at the host-to-container boundary: `lando mcp`, backed by the core-owned `McpService`, and host agent-context env forwarding into exec surfaces.

These are projections of existing contracts, not side channels. MCP publishes the command registry as typed tools, uses command result schemas, routes output through `encodeCommandResult`, redacts through `RedactionService`, and dispatches through retained-runtime command operations. Agent env forwarding carries a small exact-name allowlist only for one exec invocation, never into cached plans or persisted service env.

## Source References

- [`spec/08-cli-and-tooling.md`](../08-cli-and-tooling.md) §8.2.6 `meta mcp`; §8.3 `LandoCommandSpec.mcpAllowed`, `resultSchema`, generated allowlists, and destructive-command rejection; §8.4.1 dual-dispatch parity; §8.5.3 env precedence slot 7; §8.11 machine-readable output.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.14 `McpService` contract, allowlist, retained runtime, non-interactive dispatch, concurrency, cancellation, redaction, `pre-mcp-call` / `post-mcp-call`, tagged errors, doctor check, contract suite, and not-plugin-replaceable rule.
- [`spec/06-services.md`](../06-services.md) §6.9.1 host agent-context forwarding, default allowlist, exact-name validation, presence-gating, precedence, per-invocation scope, redaction, host-proxy shim filter append, and audit surface.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.4 top-level `agentEnv: false`; §7.5 global `mcp:` and `agentEnv:` config blocks.
- [`spec/09-embedding.md`](../09-embedding.md) §16.2 `McpService` in `@lando/core/services`; §16.7 programmatic CLI operations and `runTooling`.
- [`spec/03-architecture.md`](../03-architecture.md) §3.4 `McpService` service table row; MCP lifecycle-event scope rows for `pre-mcp-call` / `post-mcp-call`.
- [`sdk/AGENTS.md`](../../sdk/AGENTS.md) schema snapshot rule for public SDK schema changes.
- [`core/AGENTS.md`](../../core/AGENTS.md) machine-output, renderer, redaction, and dual-dispatch boundary gates.

## Goals

- Expose allowlisted Lando commands as typed MCP tools generated from `LandoCommandSpec`, never from a hand-maintained tool list.
- Keep MCP result encoding, redaction, machine output, and command dispatch identical to normal CLI and library dispatch.
- Preserve agent identity markers across `app:exec`, `app:ssh`, `app:shell --service`, and `providerExec` tooling without making env forwarding a general passthrough.
- Make the whole surface auditable through config, `lando mcp --list`, `lando doctor`, lifecycle events, schema snapshots, and executable guides.

## User Stories

### US-396: MCP command metadata, allowlist cache, schemas, and tagged errors

**Description:** As a core maintainer, I can mark safe commands with `mcpAllowed`, generate the default MCP allowlist cache, publish the MCP schemas and tagged errors, and reject destructive self-allow registrations before dangerous tools can be exposed by default.

**Acceptance Criteria:**

- [ ] `LandoCommandSpec` includes `mcpAllowed?: boolean` with default `false`, and command registration adds true entries to the generated `mcp-allowlist` cache per §8.3 and §12.1.
- [ ] The shipped default opt-ins match §8.3: read-only and laterally-scoped commands plus non-destructive lifecycle commands.
- [ ] Destructive commands (`app:destroy`, `apps:poweroff`, `meta:uninstall`, plugin mutations) never self-allow by default.
- [ ] Registration rejects any destructive built-in that declares `mcpAllowed: true` with `McpAllowlistConflictError` and remediation.
- [ ] MCP tagged errors are implemented and schema-published: `McpToolNotAllowedError`, `McpToolInputError`, `McpTransportError`, and `McpAllowlistConflictError`.
- [ ] MCP catalog, tool input, and result shapes are exported through the public schema surface without parallel hand-written public types.
- [ ] `bun run codegen:schema-snapshot` refreshes the SDK schema snapshot for the new schemas and errors.
- [ ] The generated `mcp-allowlist` cache is refreshed through the matching codegen path, and cache drift fails the relevant freshness gate.
- [ ] Machine-output conformance covers all newly exposed result schemas.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-397: Core `McpService` dispatch and redacted protocol surface

**Description:** As an AI agent using MCP, I can discover and call Lando commands as typed tools whose inputs come from command flags and args, whose results are standard command envelopes, and whose execution uses one retained Lando runtime with non-interactive, cancellable, redacted dispatch.

**Acceptance Criteria:**

- [ ] `McpService.catalog` generates one tool per effective allowlisted canonical command id from the `LandoCommandSpec` registry.
- [ ] Tool input schemas derive from `FlagSpec` and `ArgSpec`; invalid inputs fail with `McpToolInputError` carrying the flag or arg path.
- [ ] Tool results are `CommandResultEnvelope` values encoded through `encodeCommandResult`; streaming commands surface `StreamFrame` progress notifications terminated by the result envelope.
- [ ] `McpService.serve` holds one retained `LandoRuntime` and dispatches through `@lando/core/cli` command operations per §16.7, with app resolution per call.
- [ ] Tool dispatch runs with `interaction: "non-interactive"`; prompting commands fail with their standard missing-answer tagged error instead of hanging.
- [ ] Concurrency is capped with default 4, and MCP cancellation plus transport close map to `Effect.interrupt` with scope finalization.
- [ ] Every tool result, resource payload, and notification passes through `RedactionService`; `bun run check:redaction-boundary` covers the new surface.
- [ ] `pre-mcp-call` and `post-mcp-call` events publish for every dispatch, including rejected calls, with redacted payloads and tagged failure detail.
- [ ] Optional tooling-task projection uses `runTooling` when `--tooling` or `mcp.tooling: true` is effective.
- [ ] Machine-output conformance covers success and failure envelopes returned through MCP dispatch.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-398: `meta:mcp` command surface and effective-set audit mode

**Description:** As a developer configuring an agent, I can run `lando mcp` over stdio, inspect the effective tool catalog with `--list`, and tune the exposed set with `--allow`, `--deny`, `--tooling`, and global config while compiled and OCLIF dispatch behave the same.

**Acceptance Criteria:**

- [ ] `meta:mcp` serves MCP over stdio only in v4.0 and is long-running in serve mode.
- [ ] `--list` prints the effective tool catalog with id, summary, and source of allowance through the machine-output contract, then exits.
- [ ] `--allow`, `--deny`, and `--tooling` compose with global `mcp.allow`, `mcp.deny`, and `mcp.tooling`; deny wins over allow.
- [ ] `meta:mcp` bootstraps at `plugins` and constructs `McpServiceLive` lazily.
- [ ] `meta:mcp` never sets `hostProxyAllowed` or `recipePostInitAllowed`.
- [ ] Serve mode follows the §8.11.4 interactive or long-running carve-out; `--list` remains schema-valid non-interactive output.
- [ ] OCLIF dispatch and compiled `runCompiledCli` dispatch have parity tests for serve-mode startup rejection cases and `--list` output.
- [ ] Machine-output conformance covers `meta:mcp --list` success and failure envelopes.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-399: MCP contract suite and doctor check

**Description:** As a maintainer, I can prove the MCP surface remains safe and schema-faithful through a contract suite and a `lando doctor` check before users wire agents to it.

**Acceptance Criteria:**

- [ ] The §13.1 MCP contract suite asserts catalog generation matches allowlist caches.
- [ ] The suite asserts tool input schemas round-trip against `FlagSpec` and `ArgSpec`.
- [ ] The suite asserts success and failure dispatches both return schema-valid command envelopes.
- [ ] The suite asserts deny wins over allow and destructive-id self-allow registration is rejected.
- [ ] The suite asserts non-interactive prompt failure, cancellation mid-call, concurrency cap behavior, and redaction.
- [ ] `lando doctor` includes an MCP check for allowlist cache freshness, clean catalog generation, and a canary tool round-trip against the test runtime.
- [ ] Doctor output uses the universal machine-output contract and redacts any event or tool payload details.
- [ ] `bun run check:redaction-boundary` covers doctor payloads that include MCP diagnostics.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-400: Host agent-context env forwarding into exec surfaces

**Description:** As an agent running Lando commands, I can keep my host-side agent markers when work crosses into a service through exec, ssh, service shell, or providerExec tooling, while explicit env remains authoritative and forwarded values are never cached.

**Acceptance Criteria:**

- [ ] `app:exec`, `app:ssh`, `app:shell --service`, and `providerExec` tooling forward the §6.9.1 built-in allowlist when the names are present in the host env: `CLAUDECODE`, `CLAUDE_CODE`, `CURSOR_AGENT`, `OPENCODE`, `COPILOT_CLI`, `GEMINI_CLI`, `AGENT`, and `CI`.
- [ ] Forwarding is presence-gated: unset names inject no variables, not empty strings.
- [ ] Forwarding is per-invocation only and is never written into the planned service environment, app plan cache, or `LANDO_INFO`.
- [ ] Precedence follows §6.9.1 and §8.5.3 slot 7: exec request env wins, then task or service declaration, then agent-context forwarding.
- [ ] A forwarded value never overrides service env, task env, or explicit exec env.
- [ ] The in-container host-proxy shim env filter appends the resolved agent-context allowlist to `LANDO_*`, `LC_*`, `LANG`, and `TERM` so `runLando` re-entry preserves markers.
- [ ] Forwarded values in `pre-provider-exec` and transcript payloads pass through `RedactionService`; `bun run check:redaction-boundary` covers the new payload path.
- [ ] Tests cover exec, ssh, service shell, providerExec tooling, precedence losers, per-invocation freshness, and host-proxy filter append.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-401: `agentEnv` config and audit surfaces

**Description:** As a user or security reviewer, I can control and audit agent-context env forwarding through global config, app opt-out, per-invocation disablement, and `lando info --deep`, with exact-name validation that rejects wildcard patterns.

**Acceptance Criteria:**

- [ ] Global config schema adds `agentEnv: { enabled, allow, deny }` per §7.5, with `enabled: true` as the default.
- [ ] `allow` and `deny` accept exact env-var names only; wildcards or patterns fail config validation with `AgentEnvPatternError` and remediation.
- [ ] A top-level Landofile `agentEnv: false` opts that app out of forwarding per §7.4.
- [ ] `LANDO_AGENT_ENV=0` disables forwarding for a single host invocation without mutating config.
- [ ] The resolved allowlist is built as built-ins plus `allow` minus `deny`, after `enabled`, app opt-out, and per-invocation disablement are applied.
- [ ] `lando info --deep` reports the resolved allowlist for audit without reporting forwarded values.
- [ ] Global config and Landofile schema updates run `bun run codegen:schema-snapshot`.
- [ ] Machine-output conformance covers the new `lando info --deep` shape.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** MCP tools MUST be generated from the command registry and effective allowlist; no second MCP tool registry may exist.
- **FR-2:** MCP results MUST use `encodeCommandResult`, command `resultSchema`, and `RedactionService`; no per-tool JSON result encoding is allowed.
- **FR-3:** `meta:mcp` MUST be stdio-only for v4.0, never host-proxy allowed, and never recipe post-init allowed.
- **FR-4:** MCP dispatch MUST use a retained runtime, non-interactive command operations, bounded concurrency, cancellation through `Effect.interrupt`, and scope finalization.
- **FR-5:** Agent env forwarding MUST be exact-name, presence-gated, per-invocation, loser-to-explicit-env, redaction-aware, and auditable without value disclosure.
- **FR-6:** Config and schema additions MUST be reflected in schema snapshots and machine-output conformance.

## Non-Goals

- No streamable-HTTP MCP transport in v4.0.
- No plugin-replaceable `McpService` or `mcpServers:` contribution surface.
- No general host env passthrough beyond `agentEnv` exact-name forwarding.
- No forwarding of unset agent env names as empty variables.
- No container or recipe path that can start a host MCP server.

## Technical Considerations

- `McpServiceLive` is lazy at bootstrap level `plugins`; keep cold-start paths clear until `meta:mcp` or a library host requests the service.
- Tooling projection must name tools by canonical tooling ids and reuse `runTooling`, not duplicate tooling execution.
- Destructive commands can be explicitly exposed through config or flags only; default registration must fail closed.
- Redaction is security-critical because MCP payloads and agent env markers cross process and protocol boundaries.
- `lando info --deep` reports allowlist names, not values, to avoid turning the audit surface into a secret leak.

## Success Metrics

- `lando mcp --list --format json` returns a schema-valid catalog whose ids match the effective allowlist.
- The MCP contract suite covers every bullet in §10.14 and passes against the test runtime.
- A canary MCP tool call succeeds in `lando doctor`, and a denied tool call returns `McpToolNotAllowedError`.
- Agent markers survive `app:exec` and providerExec tooling when present, but explicit env wins in every precedence test.

## Guide Coverage

| Surface | Guide | Status |
| --- | --- | --- |
| `lando mcp` setup and `--list` audit | `docs/guides/agent-native/mcp.mdx` | Shipped (US-452) |
| Agent-context env forwarding | `docs/guides/agent-native/agent-env.mdx` | Planned (new guide, this PRD) |
| `lando doctor` MCP diagnostics | owned by the doctor guide surface | Update and re-run drift gate |

## Open Questions

- What exact `mcp.maxConcurrent` global config schema should expose the §10.14 default of 4? The spec names the config key but §7.5 currently lists only `allow`, `deny`, and `tooling`.
- Which commands beyond the §8.3 examples are in the final shipped default `mcpAllowed` set? Follow the generated cache and amend the spec if the default set needs to differ.
