# Boundary Rule Inventory

`registry.ts` is the canonical list of boundary rules. This inventory classifies each live rule against the workspace package DAG so ownership checks do not survive as duplicate AST policy.

Verdicts describe the next action for the current rule:

- `keep`: the rule enforces a constraint a package edge cannot express.
- `thin`: remove an ownership half but retain behavioral residue.
- `delete`: package-DAG source-edge enforcement carries the whole constraint.

The renderer rule is classified `thin` after removing two obsolete source carve-outs. Paths, probe, redaction, network, managed-file, and state-store already contain only residual enforcement. The sole `delete` verdict has been executed. The `@lando/redaction`, `@lando/http-client`, and `@lando/managed-file` package extractions paid the scanner-retirement ratchet by converting their residual rules to owner-excluding scopes and deleting obsolete owner carve-outs.

| Rule | Kind | What it bans | Package edge carrying ownership | Verdict | Justification |
| --- | --- | --- | --- | --- | --- |
| `env-helper` | `behavioral` | Service implementations importing the `lando.env` feature helpers directly | None; producer and consumers share `@lando/service-lando` | `keep` | A workspace edge cannot express an intra-package feature-ordering constraint. |
| `import-cycle` | `structural` | Runtime module cycles across first-party source trees | None; package edges do not model module-level cycles | `keep` | Package-DAG controls allowed package direction, not cycles among modules inside an allowed edge. |
| `libpod-prefix` | `behavioral` | Podman 5 `/v5.x.x` libpod API prefixes in provider production code | None | `keep` | API-version literals are independent of package ownership. |
| `machine-output` | `behavioral` | Direct command-envelope serialization and command specs without result schemas | None | `keep` | Serialization and schema-presence contracts are call-site behavior. |
| `managed-file` | `behavioral` | Lando ownership markers and overwrite logic outside `ManagedFileService` | `@lando/managed-file` owns the marker and overwrite implementation; package-DAG owns direction | `keep` | The @lando/managed-file seam owns marker and overwrite logic; a package edge cannot prevent consumers from re-spelling that logic. |
| `network` | `behavioral` | Direct global `fetch` calls outside the owning `@lando/http-client` package | `@lando/http-client` owns the only direct-fetch site; package-DAG owns direction | `keep` | The @lando/http-client seam owns the only direct-fetch site, deleting the former live.ts file carve-out; the rule is now owner-excluding and retains only the consumer-side direct-fetch ban a package edge cannot express. |
| `package-dag` | `structural` | Undeclared manifest edges, forbidden cross-package source edges, foreign test-tier entrypoint edges, and missing package test trees; test-tier findings are baseline-gated during migration | All workspace runtime and dev/test edges | `keep` | This is the primary package ownership gate. |
| `paths` | `behavioral` | Hand-rolled joins for Lando-owned plugin, binary, and scratch roots | Runtime consumers may depend on `@lando/paths`; package-DAG owns direction | `keep` | The rule is already owner-excluding and retains only derived-path construction behavior. |
| `probe` | `behavioral` | Hand-rolled `Effect.retry`, repeat, schedule, and `Schedule` probe loops instead of `runProbe` | Runtime consumers may depend on `@lando/sdk`; package-DAG owns direction | `keep` | A dependency on the SDK cannot prove the required probe primitive was called. |
| `redaction` | `behavioral` | Ad-hoc redaction sentinels and secret-matching regular expressions | `@lando/redaction` owns the canonical redactor; package-DAG owns direction | `keep` | The @lando/redaction seam owns the canonical redactor; the rule is now owner-excluding and retains only the consumer-side ad-hoc sentinel/regex ban a package edge cannot express. |
| `renderer` | `behavioral` | Direct `console.*` and `process.stdout.write` or `process.stderr.write` outside the compiled shell fast path | Runtime consumers may depend on `@lando/sdk`; package-DAG owns direction | `thin` | Package ownership cannot enforce output routing; after extraction the rule retains direct-write scanning with only the compiled shell fast path carved out. |
| `spec-reference` | `behavioral` | Durable repository files citing or reading the removable specification tree | None | `keep` | Reference text and constructed paths are content, not dependency direction. |
| `state-store` | `behavioral` | Hand-rolled atomic rename, lockfile, and version-envelope combinations | Runtime consumers may depend on `@lando/state-store`; package-DAG owns direction | `keep` | The rule is already owner-excluding and retains only the durable-write behavior combination. |
| `generated-output` | `behavioral` | Missing generated-file banners and generated banners outside generated paths | None | `keep` | Generated-source placement and banners are file-content conventions. |

## Post-extraction ratchet audit

The update, uninstall, config, and plugin extractions moved operation ownership into `@lando/engine`, while the native CLI spec split removed `core/src/cli/oclif/`. The audit below was run against that layout. A passing gate establishes that the live scope remains enforceable; the focused searches show the production subjects or owner residue that a package edge cannot replace.

| Rule | Verdict | Evidence command and finding |
| --- | --- | --- |
| **env-helper** | keep | `grep -R -n -m 3 -e landoEnvFeature -e applyEnv plugins/service-lando/src/features plugins/service-lando/src/services --include='*.ts'` found the live feature helpers in the same package as the scanned services, so the intra-package ordering ban remains behavioral. |
| **import-cycle** | keep | `grep -R -n -m 3 'from "\.' engine/src/operations core/src/cli/command-specs --include='*.ts'` found live module edges on both sides of the extraction; package-DAG still cannot detect module-level strongly connected components. |
| **libpod-prefix** | keep | `grep -R -n -m 3 '/v6\.0\.0' plugins/provider-* --include='*.ts'` found live provider API literals, whose version content is independent of package ownership. |
| **machine-output** | keep | `grep -R -n -m 3 -e 'satisfies LandoCommandSpec' -e ': LandoCommandSpec' core/src/cli/command-specs --include='*.ts'` found live `LandoCommandSpec` literals in the new command-spec tree; result-schema and envelope serialization checks remain behavioral. |
| **managed-file** | keep | `grep -R -n -m 3 -e lando-generated -e '>>> lando:' -e '<<< lando:' managed-file/src --include='*.ts'` found the marker owner residue in `@lando/managed-file`; package-DAG cannot prove consumers avoid re-spelling those sentinels. |
| **network** | keep | `grep -n -m 3 -F -e 'fetchImpl(' -e '= fetch' engine/src/http-client/live.ts` found the live egress adapter; package-DAG cannot prove callers avoid direct global fetch. |
| **package-dag** | keep | `grep -R -n -m 3 '@lando/engine' core/src/cli/commands core/src/cli/command-specs --include='*.ts'` found the new core-to-engine edges, and `bun run scripts/check-boundaries.ts package-dag` passed, confirming the primary ownership gate carries the extraction seam. |
| **paths** | keep | `grep -R -n -m 3 -e makeLandoPaths -e PathsService engine/src/operations core/src/cli --include='*.ts'` found live consumers including the extracted uninstall operation; dependency direction cannot prove derived paths use the canonical primitive. |
| **probe** | keep | `grep -R -n -m 3 'runProbe' engine/src core/src plugins --include='*.ts'` found live host/provider probes across the scanned tier; an SDK edge cannot require use of `runProbe`. |
| **redaction** | keep | `grep -R -n -m 3 -e createRedactor -e RedactionService engine/src core/src plugins --include='*.ts'` found live canonical redaction consumers; package ownership cannot reject ad-hoc sentinels or secret regexes. |
| **renderer** | thin | `grep -n -F -e 'console.' -e 'process.stdout.write' -e 'process.stderr.write' core/bin/lando.ts core/src/cli/pre-renderer.ts core/src/interaction/service.ts` found direct writes only in the compiled shell. `pre-renderer.ts` now writes through an injected stream and `interaction/service.ts` delegates fallback IO, so both source carve-outs were deleted and those files are scanned. |
| **spec-reference** | keep | `bun run scripts/check-boundaries.ts spec-reference` exercised the repository-wide content scan and reported only untracked `.omo/**` planning noise (agent-state dir, since added to `excludeDirNames` alongside `.local`); references to the removable specification tree remain content rather than package edges. |
| **state-store** | keep | `grep -R -n -m 3 '@lando/state-store' engine/src core/src plugins --include='*.ts'` found live durable-state consumers; the residual three-signal write-pattern ban remains behavior a dependency edge cannot express. |
| **generated-output** | keep | `grep -R -n -m 3 '\*\*GENERATED FILE\*\*' core/src engine/src plugins --include='*.ts'` found live generated trees and the bannered bundled-recipe allowlist; placement and banners remain file-content conventions. |

## Scanner retirement ratchet

Every new private workspace package seam must delete or shrink at least one boundary rule. Every new boundary-rule registration must carry a written seam-impossibility justification in `registry.ts` and a matching inventory row here. Net rule count must not grow without that recorded argument.

Review checklist:

- New seam: name the boundary rule it retires or shrinks.
- New rule: name why a package seam is impossible or premature.

## Package script surface

`check:boundaries` is the only package script for this inventory. Use `bun run scripts/check-boundaries.ts package-dag` to debug the workspace-DAG rule directly. The workspace DAG rejects every named, subpath, relative, type-only, re-export, and dynamic `@lando/engine` to `@lando/core` source edge.
