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
