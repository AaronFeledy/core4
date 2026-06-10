# Beta 1 decisions

## Bun floor decision

Beta 1 keeps the Bun minimum at `>=1.3.14`. The pinned CI/runtime version is `1.3.14` in `.bun-version`, and the package metadata mirrors that floor in root `package.json` and `core/package.json`.

Rationale: Bun's executable and bytecode documentation supports `bun build --compile --bytecode` for the required release targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`. The release validation surface compiles those targets with `--bytecode` instead of special-casing a target; any future target-specific failure is treated as a blocker that moves this floor rather than dropping bytecode.

Known constraints: bytecode is tied to the Bun version that produced the executable, and x64 targets may need Bun's baseline/modern target split on older CPUs. Neither constraint requires raising the Beta 1 floor today.

## OCLIF major lock decision

Beta 1 will stay on OCLIF v4. The current package metadata remains authoritative: `@oclif/core ^4.11.2` in `core/package.json` dependencies and `oclif ^4.23.0` in `core/package.json` devDependencies.

Rationale: source mode depends on OCLIF v4 command loading, manifest generation, hooks, help, and parser behavior, while the compiled `$bunfs` binary deliberately does not route through OCLIF. The permanent compiled path is the hand-rolled `runCompiledCli` router, and the compatibility contract is the existing dual dispatch model: shared command implementations, shared renderers, and the compiled-binary dispatch parity tests that compare source and compiled behavior for representative commands and failure cases.

Compatibility notes: OCLIF remains isolated to the OCLIF adapter surface and source-mode command execution. New command work must preserve the existing dependency ranges unless an explicit migration story updates source-mode loading, manifest generation, hooks, and parity coverage together. A future OCLIF v5 migration must not attempt to remove dual dispatch or make the compiled binary depend on OCLIF runtime discovery.
