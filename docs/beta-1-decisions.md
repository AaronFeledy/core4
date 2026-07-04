# Beta 1 decisions

## Bun floor decision

Beta 1 keeps the Bun minimum at `>=1.3.14`. The pinned CI/runtime version is `1.3.14` in `.bun-version`, and the package metadata mirrors that floor in root `package.json` and `core/package.json`.

Rationale: Bun's executable and bytecode documentation supports `bun build --compile --bytecode` for the required release targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`. The release validation surface compiles those targets with `--bytecode` instead of special-casing a target; any future target-specific failure is treated as a blocker that moves this floor rather than dropping bytecode.

Known constraints: bytecode is tied to the Bun version that produced the executable, and x64 targets may need Bun's baseline/modern target split on older CPUs. Neither constraint requires raising the Beta 1 floor today.

## OCLIF major lock decision

Beta 1 will stay on OCLIF v4. The current package metadata remains authoritative: `@oclif/core ^4.11.2` in `core/package.json` dependencies and `oclif ^4.23.0` in `core/package.json` devDependencies.

Rationale: source mode depends on OCLIF v4 command loading, manifest generation, hooks, help, and parser behavior, while the compiled `$bunfs` binary deliberately does not route through OCLIF. The permanent compiled path is the hand-rolled `runCompiledCli` router, and the compatibility contract is the existing dual dispatch model: shared command implementations, shared renderers, and the compiled-binary dispatch parity tests that compare source and compiled behavior for representative commands and failure cases.

Compatibility notes: OCLIF remains isolated to the OCLIF adapter surface and source-mode command execution. New command work must preserve the existing dependency ranges unless an explicit migration story updates source-mode loading, manifest generation, hooks, and parity coverage together. A future OCLIF v5 migration must not attempt to remove dual dispatch or make the compiled binary depend on OCLIF runtime discovery.

## Provider auto-setup default decision

Beta 1 chooses guided opt-in for provider setup. `lando setup` is the explicit setup entrypoint, and routine first-run commands report readiness/remediation instead of aggressively provisioning providers behind the user's back.

Defaults:

- Interactive: `lando setup` uses the managed `lando` provider default unless `--provider` or provider precedence selects another provider. It may perform the explicit setup steps the command names, but app lifecycle commands do not auto-run setup.
- Non-interactive: `lando setup --no-interactive` uses the same defaults without prompting. It must fail with remediation rather than asking follow-up questions or silently choosing an aggressive alternative.
- CI: CI and scripted use should pass explicit inputs such as `lando setup --yes`, `lando setup --provider=lando`, or skip flags. `--yes` confirms setup prompts; it does not change provider precedence or make first-run app commands provision providers implicitly.

Rejected alternative: aggressive auto-setup is not the default. If a system provider such as Docker or Podman is selected but unavailable, setup fails with remediation to install and start that runtime or rerun `lando setup --provider=lando` for the bundled managed runtime. This keeps provider readiness checks explicit and avoids host mutation from a normal `lando start`.

## Compose compatibility subset decision

Beta 1 freezes the top-level Compose project subset accepted directly by a Landofile as `services`, `volumes`, `networks`, `configs`, `secrets`, `include`, and `x-*` extension keys. Compose `version:` is accepted for compatibility, ignored by Lando, and treated as deprecated for new Landofiles.

Unsupported Compose project keys fail closed through the canonical schema/lint surface instead of being silently dropped. Known rejected Compose keys carry targeted remediation: `profiles` should be modeled as separate Landofile fragments selected with `includes:`, while non-`x-*` extension data should move to an `x-*` key or provider-specific `providers.<provider-id>` configuration. Arbitrary unsupported keys use the generic canonical-schema remediation and should be removed or handled by a config translator.

The published guide matrix is checked against the schema constants so documentation, JSON Schema, and `app:config:lint` remain aligned.

## SSH-agent sidecar opt-out decision

Beta 1 rejects `sshAgent.sidecar: false`. The supported path remains the sidecar-based SSH-agent forwarding model, with `sshAgent.sidecar: true` as the default.

Rationale: direct host SSH-agent socket mounts recreate the v3-era risk where every opted-in service can access the host agent directly. Shipping that fallback would require a separate security model, platform constraints, diagnostics, and remediation surface. Beta 1 keeps the safer sidecar default and fails closed instead of silently accepting partial direct-mount support.

Config behavior: `sshAgent.sidecar: true` is accepted and equivalent to the default. `sshAgent.sidecar: false` is reserved and rejected by Landofile validation with remediation pointing users back to the supported sidecar path; no direct host SSH-agent socket mount fallback ships in Beta 1.

## Plugin trust model decision

Beta 1 ships the plugin trust management surface now: `meta:plugin:trust list` prints the current trusted plugin names and trusted authoring roots, and `meta:plugin:trust revoke <name>` removes a persisted plugin-name trust entry. Trust grants are non-expiring Beta 1 state; users explicitly revoke plugin-name trust when it should no longer apply. Time-based expiry is rejected for Beta 1 because it would require migration, prompting, and renderer semantics without evidence that temporary trust solves the core postinstall risk.

Trust scope is source-specific. npm/registry plugin installs are keyed to the requested package identity (for example `@lando/plugin-php` from `lando plugin:add @lando/plugin-php@1.2.3`), not to attacker-controlled package manifest or `landoPlugin.name` fields. Git plugin sources require explicit `--trust` for the install session until a future git-source identity policy ships. Local/linked plugin workflows use resolved absolute authoring roots: `meta:plugin:trust-authoring-root <abs>` applies only to plugin authoring roots resolved from local/link flows, never to npm registry packages unpacked into Lando's managed plugin cache.

Flag model: `--trust` on `lando plugin:add` is an explicit one-shot install confirmation and persists the npm/registry package identity when persistent trust storage is available. non-interactive installs never prompt; an untrusted package with postinstall scripts is installed inertly with scripts disabled and remediation pointing at `lando plugin:trust <package>`. Interactive installs may prompt with the existing trusted-host-code wording for packages that need trust outside the postinstall-gated inert path; accepting that prompt trusts only the current Lando process session unless the user runs a persistent trust command.

## Release-automation posture decision

Beta 1 runs the full signed release **manually until RC**. The generated `release` workflow stays scoped to dev prereleases only: it republishes the ci-built `linux-x64` binary as a `v4.0.0-dev.N` GitHub prerelease and publishes npm `dev`-tag packages. Nothing in CI invokes the 13-stage signed release orchestrator (`scripts/release.ts`).

Rationale: the orchestrator is fully implemented and credential-gated, but release signing credential ownership (Apple notarization, Windows certificate, cosign/OIDC identity) is unassigned and no signing secrets are wired into any workflow. Wiring the full pipeline into CI now would produce a job that warning-skips every signing stage — the appearance of an automated release without a trustworthy signed artifact. Keeping the pipeline manual means a run either produces a genuinely signed release or fails closed. Full-pipeline CI is an explicit RC gate, not a Beta 1 deliverable.

Operational contract: maintainers cut `4.0.0-beta.N` by invoking `scripts/release.ts` by hand per `docs/release-runbook.md`, which documents the exact invocation, the required per-stage credentials, and the verification steps. Local rehearsal (`LOCAL_REHEARSAL=1`) exercises stage ordering without credentials.

Platform vocabulary is preserved across domains: CI/release artifact ids use `windows-x64`; the `win32-x64` runtime host key stays confined to the runtime-bundle and mutagen host-key domain and never appears in the release workflow.

Revisit at RC: assign credential owners, then decide whether to promote the full orchestrator into a credential-gated CI workflow.
