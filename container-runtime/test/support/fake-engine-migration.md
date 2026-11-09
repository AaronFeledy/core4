# Fake engine migration evidence (#2207)

The stateful fake implements the data-plane engine protocol. Containers, mounts,
volumes, images, uploads, and archives persist across requests. Attach signals its
response head before waiting for start, emits multiplexed frames, and closes stdin
only after consuming its iterable. Logs require an exited container. Unsupported
routes or transport methods fail with `FakeEngineContractError`.

Tests configure helper output and exit status independently of the command being
tested. Failures, defects, interruptions, and hangs are injected by operation name.
`fail` supports one-shot and persistent responses; `hang` uses `Effect.never`.
The request ledger records operation, method, and path. Raw request observations
are retained for existing payload assertions.

## Preservation ledger

Each file was run individually before and after migration. Counts include expanded
table rows. Every existing assertion was retained: an AST comparison against HEAD
found the same 382 assertion expressions across the 14 changed existing files.
Runtime assertion counts also remain identical.

| File (`container-runtime/test/`) | Tests before | Tests after | Assertions before / after |
| --- | ---: | ---: | ---: |
| data-plane.test.ts | 109 | 109 | 344 / 344 |
| data-plane-error-identity.test.ts | 65 | 65 | 962 / 962 |
| data-plane-cleanup.test.ts | 28 | 28 | 104 / 104 |
| data-plane-cleanup-deadline.test.ts | 16 | 16 | 140 / 140 |
| data-plane-passthrough.test.ts | 20 | 20 | 53 / 53 |
| ephemeral-http-reason.test.ts | 92 | 92 | 370 / 370 |
| data-plane-helper-images.test.ts | 5 | 5 | 16 / 16 |
| run-capture.test.ts | 1 | 1 | 3 / 3 |
| command-output.test.ts | 21 | 21 | 83 / 83 |
| copy-to-service.test.ts | 2 | 2 | 4 / 4 |
| volume-witness-plan.test.ts | 2 | 2 | 18 / 18 |
| volume-witness-restore.test.ts | 1 | 1 | 4 / 4 |
| snapshot-images.test.ts | 2 | 2 | 3 / 3 |
| bring-down-ephemeral-helpers.test.ts | 12 | 12 | 46 / 46 |
| **Existing totals** | **376** | **376** | **2,150 / 2,150** |

New coverage: `fake-engine.test.ts` has 5 passing tests and 11 assertions;
`fake-engine-parity.integration.test.ts` has 4 passing fake scenarios and 4 skipped
live scenarios, with 7 assertions executed. Both backends run the same scenario
bodies and expected results: attach stdout/stderr/exit, missing-image create HTTP
404, volume create/list/remove, and a buffered nonzero helper exit. Live parity
requires `LANDO_TEST_PODMAN_SOCKET` and an already available
`docker.io/library/busybox:1.37` image. The tests do not pull images.

## Mutation receipts

All three runs used:

```sh
bun run /home/aaron/.config/opencode/node_modules/oh-my-openagent/packages/shared-skills/skills/programming/scripts/typescript/mutation-proof.ts --file container-runtime/src/data-plane.ts --find '<original>' --replace '<mutant>' --test 'keeper=<command>' --json
```

| Behavior | Original replaced | Mutant | Keeper command | Result |
| --- | --- | --- | --- | --- |
| Nonzero helper plus failed cleanup | `return outcome === undefined \|\| outcome.exitCode === 0 ? undefined : outcome;` | `return undefined;` | `bun test container-runtime/test/data-plane-cleanup.test.ts -t nonzero` | Red: 1 failed, 3 passed, 8 assertions. Lost `ProviderInternalError` and exit code 9. |
| Transport identity pass-through | `: options.api.request(input).pipe(redactFailures(options.redactor));` | `: options.api.request(input).pipe(Effect.catch(() => Effect.fail(missingDataPlaneClient(options, operation, "request"))));` | `bun test container-runtime/test/data-plane-passthrough.test.ts -t identity` | Red: 6 failed, 2 passed, 18 assertions. Original operation and remediation were replaced. |
| Volume-in-use holder diagnostics | `if (inUse) {` | `if (false) {` | `bun test container-runtime/test/bring-down-ephemeral-helpers.test.ts -t direct` | Red: 1 failed, 2 assertions. The redacted holder ID disappeared from the error message. |

Every run reported identical original and restored SHA-256:
`411bd8919125ce400d8318fba610d8070ca3e5ca47f272cb5e5c24d915388636`.
The normal suite passed after restoration. No production changes are included.

## Gates

Both socket variables were removed from the test command's environment so no live
engine was contacted:

```sh
env -u LANDO_TEST_PODMAN_SOCKET -u LANDO_TEST_DOCKER_SOCKET bun test container-runtime/test
bun run typecheck
bun run lint
bun run check:boundaries
```

- Package tests: **2,222 pass, 6 skip, 0 fail**, 12,350 assertions, 146 files.
- Typecheck: passed (`tsc -b`).
- Lint: exit 0; 6,248 files checked and deprecation check passed. One existing
  warning remains in untouched `state-store/src/volume-initialization.ts:91`
  (`noUnusedVariables`, parameter `to`).
- Boundaries: all 14 checks passed.
- LSP diagnostics for `container-runtime/test`: zero errors, including imported code.
- `check-test-junk.ts`: no findings across all changed test files.
- The auxiliary `check-no-excuse-rules.ts` could not load
  `typescript/unstable/async` and `typescript/unstable/ast` from this repository's
  TypeScript aliases. No dependency was added to accommodate that external tool.
  New helper modules are each below 250 physical lines, and the changed large
  existing suites shrink rather than gaining fixtures.
- `git diff --check`: passed.

## Retained local clients

- `log-file-access.test.ts`: retained its exec/session protocol fakes, including
  `makeFakeApi`, `protocolApi`, and fault fixtures. These exercise `/exec` and the
  log-file helper's JSON protocol. Adding that protocol would exceed the explicit
  restriction to endpoints called by the data plane; replacing it with canned
  data-plane output would weaken those assertions.
- `log-source-binding.test.ts`: retained the fallback/exec clients for the injected
  access test and the bound container/provider test, for the same exec-protocol
  reason. Neither file calls `makeProviderDataPlane`.
- `ephemeral-data-helpers.integration.test.ts`: retained its request observer around
  a real engine client. It deliberately starts a real holder during discovery;
  replacing it with the fake would remove its live race coverage. It was skipped.
- Other `bringDown`-only `EngineHttpApi` fixtures in
  `bring-down-ephemeral-helpers.test.ts` remain local. Its direct data-plane removal
  test now obtains HTTP 409 and the holder listing from actual fake mount state.

The fake owns engine state and protocol behavior; its route decoder owns endpoint
recognition, and fixture scripts only select outcomes or observe operations. There
are no added dependencies, production seams, timer-based synchronization, type
suppression directives, or weakened assertions.
