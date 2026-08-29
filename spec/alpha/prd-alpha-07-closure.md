# PRD: Alpha-07: Closure

## Introduction

Alpha 1 exits when the six-target unsigned `dev.N` artifacts exist and every compile target has live setup, live doctor, live Drupal, and live Rails. Compile smoke is not an exit. ROADMAP edits are not an exit.

## Source References

- [`prd-alpha-00-index.md`](./prd-alpha-00-index.md) exit criteria
- [`progress.txt`](./progress.txt) dependency graph and `passes: false` starting state

## User Stories

### US-600: Alpha 1 exit lock

**Description:** As a maintainer, Alpha 1 exits only when US-593..US-599 are true with live all-six setup, doctor, Drupal, and Rails evidence.

**Acceptance Criteria:**

- [ ] US-593 through US-599 are `passes: true` on one tree.
- [ ] All six compile targets have live `lando setup`, live `lando doctor`, live Drupal canonical journey, and live Rails canonical journey. Compile smoke is not an exit.
- [ ] The public artifact remains unsigned `4.0.0-dev.N` on the `dev` channel.
- [ ] ROADMAP edits are not an exit substitute. Signing, installers, self-update, and Beta remain non-goals.
- [ ] Tests pass; typecheck passes; lint passes

**Failure path:** Exit with any target missing live evidence, or claiming a signed/Beta/GA release.

**Verification:** Six-target evidence matrix plus `bun test` (positive counts), `bun run typecheck`, `bun run lint`, and touched semantic gates.
