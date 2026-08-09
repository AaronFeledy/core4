# Boundary Rule Inventory

`registry.ts` is the canonical list of boundary rules. This inventory classifies each live rule against the workspace package DAG so ownership checks do not survive as duplicate AST policy.

Verdicts describe the next action for the current rule:

- `keep`: the rule enforces a constraint a package edge cannot express.
- `thin`: remove an ownership half but retain behavioral residue.
- `delete`: package-DAG source-edge enforcement carries the whole constraint.

No live rule is classified `thin`: the paths, probe, redaction, renderer, and state-store rules contain only their residual enforcement. The sole `delete` verdict has been executed.

| Rule | Kind | What it bans | Package edge carrying ownership | Verdict | Justification |
| --- | --- | --- | --- | --- | --- |
| `env-helper` | `behavioral` | Service implementations importing the `lando.env` feature helpers directly | None; producer and consumers share `@lando/service-lando` | `keep` | A workspace edge cannot express an intra-package feature-ordering constraint. |
| `import-cycle` | `structural` | Runtime module cycles across first-party source trees | None; package edges do not model module-level cycles | `keep` | Package-DAG controls allowed package direction, not cycles among modules inside an allowed edge. |
| `libpod-prefix` | `behavioral` | Podman 5 `/v5.x.x` libpod API prefixes in provider production code | None | `keep` | API-version literals are independent of package ownership. |
| `machine-output` | `behavioral` | Direct command-envelope serialization and command specs without result schemas | None | `keep` | Serialization and schema-presence contracts are call-site behavior. |
| `managed-file` | `behavioral` | Lando ownership markers and overwrite logic outside `ManagedFileService` | None; the service and most consumers share `@lando/engine` | `keep` | Marker and write-pattern use cannot be represented by a workspace dependency edge. |
| `network` | `behavioral` | Direct global `fetch` calls outside the `HttpClient` adapter | None | `keep` | An allowed package dependency cannot require every egress call to use one adapter. |
| `package-dag` | `structural` | Undeclared manifest edges and forbidden cross-package source edges | All workspace runtime and dev/test edges | `keep` | This is the primary package ownership gate. |
| `paths` | `behavioral` | Hand-rolled joins for Lando-owned plugin, binary, and scratch roots | Runtime consumers may depend on `@lando/paths`; package-DAG owns direction | `keep` | The rule is already owner-excluding and retains only derived-path construction behavior. |
| `probe` | `behavioral` | Hand-rolled `Effect.retry`, repeat, schedule, and `Schedule` probe loops instead of `runProbe` | Runtime consumers may depend on `@lando/sdk`; package-DAG owns direction | `keep` | A dependency on the SDK cannot prove the required probe primitive was called. |
| `redaction` | `behavioral` | Ad-hoc redaction sentinels and secret-matching regular expressions | Runtime consumers may depend on `@lando/sdk`; package-DAG owns direction | `keep` | A dependency on the SDK cannot prove the canonical redactor was used. |
| `renderer` | `behavioral` | Direct `console.*` and `process.stdout.write` or `process.stderr.write` outside shell fast-path carve-outs | Runtime consumers may depend on `@lando/sdk`; package-DAG owns direction | `keep` | Package ownership cannot enforce output routing or the narrow shell carve-outs. |
| `spec-reference` | `behavioral` | Durable repository files citing or reading the removable specification tree | None | `keep` | Reference text and constructed paths are content, not dependency direction. |
| `state-store` | `behavioral` | Hand-rolled atomic rename, lockfile, and version-envelope combinations | Runtime consumers may depend on `@lando/state-store`; package-DAG owns direction | `keep` | The rule is already owner-excluding and retains only the durable-write behavior combination. |
| `generated-output` | `behavioral` | Missing generated-file banners and generated banners outside generated paths | None | `keep` | Generated-source placement and banners are file-content conventions. |

## Scanner retirement ratchet

Every new private workspace package seam must delete or shrink at least one boundary rule. Every new boundary-rule registration must carry a written seam-impossibility justification in `registry.ts` and a matching inventory row here. Net rule count must not grow without that recorded argument.

Review checklist:

- New seam: name the boundary rule it retires or shrinks.
- New rule: name why a package seam is impossible or premature.

## Retired rule aliases

- `core-layering`: `check:core-layering-boundary` → `check:package-dag`. The workspace DAG now rejects every named, subpath, relative, type-only, re-export, and dynamic `@lando/engine` to `@lando/core` source edge; the stable command remains an alias for existing local callers.
