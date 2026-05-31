# core/AGENTS.md

Inherit the root `AGENTS.md` instructions for all core package work.

## Executable Guide TDD

- Use `bun run dev:guides` from the repo root as the dev-time TDD loop for executable guides. It regenerates guide scenarios, typechecks the generated path, and re-runs the affected guide scenario tests on changes to guide MDX, core/sdk/plugin source, or the scenario generator.
- Use `bun run dev:guides docs/guides/<path>.mdx` for a focused single-guide loop, and add `--once` for a single non-watching pass.
