# PRD: L3P-07 — Docs residue + wave closure

## Introduction

The parity audit's documentation backlog is nearly complete; three residual items remain feasible today and independent of the rest of this wave, plus the closure story that re-audits parity and locks the wave's gates. Doc stories load the `lando-write-docs` skill.

## Source References

- `.local/LANDO3-PARITY.md` §5–§7 residual rows (cache-refresh, verbosity, DNS rebind, parity table itself).
- [`spec/17-executable-tutorials.md`](../17-executable-tutorials.md) executable-guide model; guide coverage/drift gates.

## User Stories

### US-580: Residual guides (cache refresh, verbosity, DNS rebind)

**Description:** As a user, I can find executable guidance for `app:cache:refresh`, CLI verbosity/debug output, and the DNS-rebinding caveat for custom domains.

**Acceptance Criteria:**

- [ ] `docs/guides/cli/cache-refresh.mdx`: when/why plan caches go stale, `lando cache:refresh` walkthrough with a rendered before/after scenario.
- [ ] `docs/guides/cli/verbosity-and-debug.mdx`: renderer modes (`--renderer=verbose|plain|json`), debug env/log guidance — the v3 `lando --debug` analog.
- [ ] DNS-rebinding note added to the external-access or proxy guide (custom-domain routers that block rebinding + remediation), whichever page users hit first; cross-linked.
- [ ] INDEX + coverage/drift/lint gates green (`check:guide-coverage`, `check:guide-drift`, `lint:guides`).
- [ ] Tests pass; typecheck passes; lint passes.

### US-581: Parity refresh + wave closure

**Description:** As a maintainer, the parity audit reflects reality after this wave, and the whole wave's verification contract is green on one tree.

**Acceptance Criteria:**

- [ ] `.local/LANDO3-PARITY.md` refreshed: every previously-❌ row now ✅ or carries a recorded decision citation (hosters → 4.1 RemoteSource; SSH mounts → rejected; staged recipes → §8.8.10 staged list); stale rows from the 2026-08-09 snapshot corrected.
- [ ] Deferred-command map (`core/src/cli/deferred-commands.ts`) reviewed: entries this wave implemented are removed; remaining entries carry accurate phase notes.
- [ ] Full gate sweep on the closure tree: `bun test` (positive counts), `bun run typecheck`, `bun run lint`, `bun run codegen:check`, `bun run check:boundaries`, `bun run check:guide-coverage`, `check:guide-drift`, `check:public-transcripts`, `lint:guides`.
- [ ] §8.8.10 table verified against `recipes/` contents; §6.12.1 rows verified against the runtime registry (every row registered, every registration in a row).
- [ ] Tests pass; typecheck passes; lint passes.
