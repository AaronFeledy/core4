# PRD: BETA1-02 — Managed-file contract completion

## Introduction

PRD-ALPHA4-18 shipped the `ManagedFileService` working-tree write primitive (§10.13) substrate-only. The gap audit found three contract shortfalls behind its green stories:

1. **Redaction is not wired.** The PRD requires "Every `ManagedFile` event and transcript MUST be routed through `RedactionService`", but `core/src/managed-file/service.ts` builds a local `createSecretRedactor([])` (an *empty* redactor) and `ManagedFileServiceLive` never resolves `RedactionService`. Managed-file events can therefore leak values the canonical redaction registry would have masked.
2. **The path surface is missing.** The PRD requires `PathsService` / `@lando/core/paths` to gain a `managedFileLedger(appId)` derived path; only an internal helper exists in `core/src/config/roots.ts`, so plugins and hosts cannot resolve the ledger location through the sanctioned surface.
3. **Schema drift.** The PRD freezes `FileFormat` as `"text" | "env" | "json" | "yaml" | "toml" | "ini" | "landofile"`, but the shipped schema (`sdk/src/schema/managed-file.ts`) adds `"javascript"` and `"typescript"`. Because `@lando/sdk` schemas are API-stable from the moment they ship, this divergence must be reconciled deliberately — in the schema or in the PRD — not left silent.

## Source References

- [`spec/alpha-4/prd-alpha-4-18-managed-files.md`](../alpha-4/prd-alpha-4-18-managed-files.md) — the originating requirements.
- [`spec/11-subsystems.md`](../11-subsystems.md) §10.13 `ManagedFileService`.
- [`spec/03-architecture.md`](../03-architecture.md) §3.7 canonical redaction.
- [`spec/07-landofile-and-config.md`](../07-landofile-and-config.md) §7.5.1 Paths/Roots primitive.
- [`sdk/AGENTS.md`](../../sdk/AGENTS.md) — SDK surface change rules, `API_COMPATIBILITY.md`, schema snapshot.

## Goals

- Route every managed-file event/transcript payload through the canonical `RedactionService`.
- Publish `managedFileLedger(appId)` on the sanctioned paths surface and migrate internal callers.
- Reconcile `FileFormat` with the frozen contract — one way or the other — with PRD text, schema, snapshot, and compatibility docs moving together.

## User Stories

### US-379: Managed-file events route through `RedactionService`

**Description:** As a security-conscious user, managed-file events and transcripts never contain unredacted secrets, because the service uses the canonical redaction registry instead of a local empty redactor.

**Acceptance Criteria:**

- [ ] `ManagedFileServiceLive` resolves `RedactionService` and uses it for every event payload and transcript line it emits; `createSecretRedactor([])` is removed from `core/src/managed-file/service.ts`.
- [ ] A test proves a registered secret value appearing in a managed-file event payload (e.g. in a content diff or error message) is masked in the emitted event.
- [ ] The `check:redaction-boundary` gate covers the managed-file event path (add the surface to the gate's inventory if it enumerates consumers).
- [ ] `ManagedFileService` layer wiring provides `RedactionService` directly to the layer that needs it (per the `Layer.mergeAll` sibling-visibility gotcha in root `AGENTS.md`).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-380: `PathsService.managedFileLedger(appId)`

**Description:** As a plugin author or embedding host, I can resolve the managed-file ledger path for an app through `PathsService` / `@lando/core/paths` instead of re-deriving it.

**Acceptance Criteria:**

- [ ] `PathsService` (`sdk/src/services/paths.ts`) gains `managedFileLedger(appId: string)` returning the derived ledger path; the pure `makeLandoPaths` peer gains the equivalent member.
- [ ] `core/src/config/roots.ts`'s `managedFileLedger` helper delegates to (or is replaced by) the primitive; internal callers (`core/src/managed-file/service.ts`) migrate to the service surface.
- [ ] The addition follows `sdk/AGENTS.md`: `sdk/API_COMPATIBILITY.md` updated, `bun run codegen:schema-snapshot` refreshed, export/import-boundary tests updated.
- [ ] `check:paths-boundary` passes; no hand-rolled ledger path joins remain.
- [ ] Path-matrix tests cover the new member across platforms (win32/linux/darwin separators, overridden roots).
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

### US-381: Reconcile `FileFormat` with the frozen contract

**Description:** As an SDK consumer, the shipped `FileFormat` enum and the PRD-ALPHA4-18 contract say the same thing: either the JS/TS formats are formally adopted into the contract, or the schema is trimmed back to the frozen 7-value enum before Beta hardens further.

**Acceptance Criteria:**

- [ ] A decision is recorded in this story's notes: adopt `"javascript"`/`"typescript"` into the contract, or remove them from `sdk/src/schema/managed-file.ts`.
- [ ] If adopted: `spec/alpha-4/prd-alpha-4-18-managed-files.md` (and §10.13 if it enumerates formats) is updated to the 9-value enum, codec behavior for the two formats is tested (write/read round-trip, marker handling), and the schema snapshot reflects the adopted surface.
- [ ] If trimmed: the two values are removed, no shipped consumer references them (verified by search + tests), and the schema snapshot is refreshed.
- [ ] Either way: PRD text, schema, snapshot, and `sdk/API_COMPATIBILITY.md` agree after the change; no silent drift remains.
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- **FR-1:** No managed-file event, transcript, or error leaves the service unredacted.
- **FR-2:** The managed-file ledger location is resolvable only through the paths primitive.
- **FR-3:** SDK schema text and PRD contract text are equal for `FileFormat`.

## Non-Goals

- No user-facing managed-file consumers (CMS settings management, `lando add`, `files:` key) — those remain 4.x per PRD-ALPHA4-18.
- No ledger format redesign (owned by US-373 in PRD-BETA1-01).

## Technical Considerations

- US-373 (json-bucket retirement) touches the same service file; land US-373 first or coordinate the rebase.
- The empty-redactor pattern may exist because `RedactionService` was not available at that layer's construction time; the fix is to provide it directly to the sub-layer, not to widen a merge.
- `javascript`/`typescript` formats likely exist for CMS settings-file emission; check `git log` for the introducing story before deciding trim vs adopt.

## Success Metrics

- `createSecretRedactor([])` has zero call sites under `core/src/managed-file/`.
- `grep -rn "managedFileLedger" core/src plugins` shows only paths-primitive-routed usage.
- Schema snapshot diff for `FileFormat` matches the recorded decision.

## Guide Coverage

**None — internal/infra PRD.**

`ManagedFileService` is substrate-only in Beta; its user-facing consumers (and their guides) ship in 4.x.

## Open Questions

- Was the JS/TS `FileFormat` widening introduced by a reviewed story with intent (adopt), or opportunistically (trim)? The implementing engineer must check the introducing commit before choosing.
