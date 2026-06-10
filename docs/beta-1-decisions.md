# Beta 1 decisions

## Bun floor decision

Beta 1 keeps the Bun minimum at `>=1.3.14`. The pinned CI/runtime version is `1.3.14` in `.bun-version`, and the package metadata mirrors that floor in root `package.json` and `core/package.json`.

Rationale: Bun's executable and bytecode documentation supports `bun build --compile --bytecode` for the required release targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`. The release validation surface compiles those targets with `--bytecode` instead of special-casing a target; any future target-specific failure is treated as a blocker that moves this floor rather than dropping bytecode.

Known constraints: bytecode is tied to the Bun version that produced the executable, and x64 targets may need Bun's baseline/modern target split on older CPUs. Neither constraint requires raising the Beta 1 floor today.
