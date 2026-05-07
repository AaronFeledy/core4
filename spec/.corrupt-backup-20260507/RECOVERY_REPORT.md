# Spec Corruption Recovery Report — 2026-05-07

## Summary

Six files in `spec/` were damaged by a Write/Edit-tool bug that replaces literal `$` characters in new file content with the entire pre-write contents of the file. Where the original content contained `Bun.$` (Bun shell API), this produced inline duplicates of the file. Some files had a single clobber; `spec/08-cli-and-tooling.md` had recursive damage from multiple bad-write passes (~73 nested clobbers, 1.9 MB).

The bug is **still active** in the current session's Edit tool (verified with a probe write). All repairs in this report were performed via `bash` heredocs (single-quoted delimiter to preserve `$` literally). Future edits that contain `$` MUST use the same approach.

The full pre-repair contents of all six damaged files are preserved in this directory.

## Files repaired

| File | Pre-repair size | Post-repair size | Method | Edits potentially lost |
|---|---|---|---|---|
| `04-pluggability.md` | 15,702 B | 11,279 B | Surgical: deleted lines 38–72, reconstructed the `Bun.$` Shell-execution row | None — all surviving prefix/suffix preserved |
| `11-subsystems.md` | 27,653 B | 14,646 B | Surgical: deleted lines 195–379, reconstructed the doctor-transcripts paragraph | None |
| `14-appendices.md` | 51,209 B | 24,289 B | Surgical: 4 sites; reconstructed §15.C ShellRunner acceptance bullets from prefix + tail content | None — surviving suffixes were found at lines 153, 230, 310, 391 |
| `15-binary-build-and-release.md` | 39,280 B | 35,754 B | Surgical: 2 sites in §17.1; reconstructed the orchestrator paragraph with both `Bun.$` references | None |
| `README.md` | 41,871 B | 22,639 B | Surgical: 1 site; reconstructed the topic-lookup row for orchestrator policy | None |
| `08-cli-and-tooling.md` | 1,937,985 B | 70,315 B | **Stversion restore + tail splice** | **YES** — see below |

## What was lost in `spec/08-cli-and-tooling.md`

The corruption in spec/08 was recursive (~3 bad-write passes), nesting full prior versions of the file inside itself. Recovery was not feasible without a clean snapshot. The most recent clean snapshot was a syncthing stversion from **2026-05-06 23:06** (`08-cli-and-tooling~20260506-221650.md`, 66,564 bytes, 1014 lines).

That stversion is the baseline for the restored `spec/08`. On top of it I spliced:

1. The **§8.9 Renderers and messages** section (latest version, with the new `emitImmediate` API on the Renderer interface and `paint.banner` event) extracted from the *intact tail* of the corrupt file (lines 23617–23674).
2. The **§8.9.1 First-paint contract** subsection (entire new addition, ~30 lines) extracted from the same intact tail.
3. The **header version bump** `Part 8 of 14` → `Part 8 of 15`.

### What is **definitely missing** from the restored spec/08

The corrupt file showed evidence of six `Bun.$`-related paragraphs that the user added between **2026-05-06 23:06** (last clean stversion) and **2026-05-07 13:50** (corruption). All six are NOT in the restored file. The audit identified the six original paragraph locations:

| Where it lived | Topic | Sketch of the lost text |
|---|---|---|
| §8.2.3 `app:shell` description (line 151 of corrupt file) | `app:shell` requires a TTY; defaults to host mode (`Bun.$` REPL) | `app:shell` requires a TTY; with `--no-interactive` it errors with `ShellRequiresTtyError`. Defaults to host mode (a `Bun.$`-backed REPL). |
| §8.2.3 host-mode default (line 386) | Host mode default | **Host mode (default).** A `Bun.$`-backed REPL with the app's `LANDO_*` env, host paths, `host.lando.internal` resolution active. |
| §8.5.3 dynamic `sh:` values (line 1102) | Dynamic `sh` evaluation via `ShellRunner` | Dynamic `sh` values run through the task's selected engine. For `service: :host` they run through `ShellRunner` (the `Bun.$`-backed primitive). |
| §8.5.9 `.bun.sh` script body example (line 2353) | Bare `await $\`…\`` template tag inside a `.bun.sh` code fence | (Inside a `.bun.sh` example code fence: `await $\`bun run build\``) |
| §8.5.9 `.bun.sh` script body description (line 9316) | The script body MAY use any Bun API | The script body MAY use any Bun API. In particular, `Bun.$` is available without import for shell-shaped composition. |
| §8.6 `host` engine description (line 11650) | Built-in alternative: the `host` engine | **Built-in alternative: the `host` engine.** Core ships a `host` engine alongside `providerExec` for tasks that target `service: :host` or set `engine: host`. The `host` engine is `ShellRunner`-backed (§3.4): it executes each step through `Bun.$`. |

These paragraphs need to be re-authored when the user resumes work on §8.

### What **may** also be missing

Between 2026-05-06 23:06 and 2026-05-07 13:50, the user could have made other edits to §8.1–§8.8 that aren't captured by the syncthing stversion (versioning interval missed them) and aren't recoverable from the corrupt file (they're nested deep inside the recursion). The user should review §8.1–§8.8 against memory of recent work and re-apply anything missing.

The clearly-recovered new content in the restored file:
- `Part 8 of 15` header
- §8.9 Renderer interface with `emitImmediate` API and `paint.banner` event
- §8.9.1 First-paint contract section (entire ~30-line addition)

## Cross-cutting impact: `ShellRunner` references in other parts

The 5 other repaired files all contain `Bun.$` references that depend on §8 sections that are now stubbed (the §8.2.3 `app:shell`, §8.5.3 dynamic `sh:`, §8.5.9 `.bun.sh`, §8.6 `host` engine references). The `Bun.$` references survive in:

- `spec/03-architecture.md` (clean, untouched — has `ShellRunner` service tag in §3.4 catalog)
- `spec/04-pluggability.md` (repaired — has the `ShellRunner` row in §4.2 catalog)
- `spec/11-subsystems.md` (repaired — has the `Diagnostic transcripts` paragraph)
- `spec/13-testing-and-distribution.md` (clean, untouched)
- `spec/14-appendices.md` (repaired — has 4 §15.C acceptance bullets)
- `spec/15-binary-build-and-release.md` (repaired — has §17.1 orchestrator paragraph with both `Bun.$` and `Bun.spawn`)
- `spec/README.md` (repaired — has the topic-lookup row for orchestrator policy)

**These cross-references will dangle** until the missing §8 ShellRunner paragraphs are re-authored. The acceptance bullets in §14 §15.C reference `(§3.4)`, `(§8.5.3)`, `(§8.5.9)`, `(§8.6)`, `(§8.2.3)`, `(§10.5)`, `(§8.8.8)`, `(§10.9)` — those §-anchors exist but the paragraphs they describe are missing in §8.

## Rollback information

If any of the repairs are wrong, the unedited corrupt versions are in this directory:

```
spec/.corrupt-backup-20260507/
├── 04-pluggability.md           (15,702 B)
├── 08-cli-and-tooling.md        (1,937,985 B — recursive corruption)
├── 11-subsystems.md             (27,653 B)
├── 14-appendices.md             (51,209 B)
├── 15-binary-build-and-release.md (39,280 B)
└── README.md                    (41,871 B)
```

Syncthing stversions (older clean snapshots) are at:

```
~/.stversions/projects/experiments/lando4-rewrite2/spec/
```

with three timestamped versions per file (2026-05-04, 2026-05-05, 2026-05-06). The 2026-05-06 versions are the most recent clean snapshots prior to the corruption.

## Tooling recommendation

Before any further work on this spec tree:

1. **Do not use the Edit/Write tools on content containing `$`.** The bug is live in this session. Use bash heredocs with single-quoted delimiters or write scripts that read/write files directly.
2. **Consider initializing a git repo** in this project to prevent this class of loss going forward. There is currently no version control.
3. The `.corrupt-backup-20260507/` directory may be safely deleted once the user has reviewed this report and confirmed the recovery is acceptable.
