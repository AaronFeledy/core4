# Unit-suite baseline

A measured record of which unit tests are red, and why. Maintainer-facing: this
page is evidence, not a guide.

The point of measuring is attribution. A raw failure count tells you nothing,
because most red tests in this suite are not independent defects — they are one
process-wide contamination reported once per victim. Every entry below therefore
carries its own single-file reproduction, and an entry only counts as a real
failure if it reproduces when that file runs alone.

## How to re-measure

```bash
bun run test:unit                     # whole-suite count
bun --no-orphans test <path>          # per-file reproduction
```

`test:unit` excludes only `**/*.integration.test.ts`. It does **not** apply the
CI shard exclusions, so it also runs the generated guide scenarios that CI gives
their own job family. Expect it to take roughly 25 minutes.

A file that fails under `test:unit` but passes on its own is not a defect in
that file. It is a victim of something earlier in the run, and the cause belongs
to the leaking file, not to the 160 files that report it.

## Measured baseline

| | |
| --- | --- |
| Measured | 2026-09-20, Linux x64, no container runtime |
| Command | `bun run test:unit` |
| Result | 14,569 pass · 14 skip · **205 fail** · 1,655 files · 1,534s |

The historical figure of thirteen failures was carried forward without
re-measurement and is retired. It was never accurate for the current tree.

**205 reported failures resolve to 18 on the first isolation pass** (9 + 6 + 1 +
2). Ten non-generated files and 155 generated guide-scenario files reported
failures. 187 is the residual `205 − 18`, not a sum of the in-suite victim
counts below. A later isolation re-check dropped `start.scenario.test.ts` from
6 fails to 1, so the reproducing isolated set is 13 (9 + 1 + 1 + 2); the extra
five do not get their own queue entries. The other 187 remain one leaked
`process.chdir` (see *Cross-file contamination*).

## Reproducing failures

Each reproducing isolated failure is its own item with its own reproduction.
They share no cause. A first isolation pass that does not survive a second run
is a lead, not a queued defect.

### `core/test/app/resolve.test.ts` — 9 failures

```bash
bun --no-orphans test core/test/app/resolve.test.ts   # 12 pass, 9 fail
```

Every failure is a `resolveApp > …` case timing out at the 5,000 ms default.
The first timeout removes the temp root out from under the tests that follow,
so the count is not stable across runs.

**Queued as US-661**, which owns this cascade specifically and requires the fix
to be an isolation fix in `withTempApp` / `withTwoTempApps` rather than a raised
timeout.

### `core/test/cli/start.scenario.test.ts` — 1 reproducing failure

```bash
bun --no-orphans test core/test/cli/start.scenario.test.ts
```

A first isolation pass during measurement reported 41 pass / 6 fail. Re-running
the file is 46 pass / 1 fail. The only reproducing case is `scaffolds an app
and starts it against the live Podman socket`.

That case is already `test.skipIf(resolveLiveProviderSocket() === undefined)`.
On this host the gate opened (a socket answered) and `lando start` then exited
1 after ~16 s. **Queued** as environment-gated, not as a code defect. Reproduce
only where a live provider is intended:

```bash
bun --no-orphans test core/test/cli/start.scenario.test.ts --test-name-pattern 'live Podman socket'
```

The other five from the first isolation pass — three interruption/rollback
timeouts at ~5,010 ms, `Expected task event was not published`, and a
malformed-Landofile path — do not reproduce. Selected by name they pass, and
the file minus the live-socket case is 46 pass / 0 fail. They are not
independent queued items.

### `core/test/scenario/mvp-exit-criteria.scenario.test.ts` — 1 failure — **retired**

The `@smoke` case drove the compiled binary through init/start/info/stop and
failed on a runtime-free host with `GlobalAutoStartError` → `ServiceStartError`
on the `traefik` service, because it ran whenever any provider socket resolved.

Retired in favor of the `real-provider-loop` e2e scenario in
`docs/guides/tutorial/app-lifecycle.mdx`, which makes the same promise but is
`test.skip` unless `LANDO_GUIDE_E2E=1`, `LANDO_SCENARIO_E2E_BINARY`, and a live
provider socket are all set. The remaining live suites moved from
`core/test/scenario/` to `core/test/live/`.

### `core/test/cli/uninstall-runtime-service.test.ts` — 2 failures — **fixed here**

```bash
bun --no-orphans test core/test/cli/uninstall-runtime-service.test.ts
```

`skips host maintenance when the registry is absent` and `removes runtime
artifacts when no owned runtime service is running` both asserted
`result.failed === false` and got `true`.

Neither runtime-service step was at fault. The file's local `sandboxUninstallIo`
helper redirected only `cgroupsDelegatePath` and `shellProfilePath` into the
temp root, so the socket-proxy helper step kept its real defaults of
`/etc/systemd/system/lando-proxy-*.{socket,service}` and
`/etc/polkit-1/rules.d/10-lando-proxy.rules`. A host carrying Lando-owned proxy
units — this one does — classifies that step as owned, attempts `systemctl stop`
without privilege, and fails the whole uninstall run.

The fix completes the sandbox so every host-reaching path lands in the temp
root, matching the helper `core/test/cli/uninstall.test.ts` already uses. No
assertion was weakened: `result.failed === false` still holds.

## Cross-file contamination

Six non-generated files and all 155 generated guide-scenario files reported
failures under `test:unit` and pass when run alone. The in-suite fail counts
on the commands below illustrate victim files; they are not addends of the
187 residual.

```bash
bun --no-orphans test engine/test/operations/applied-state-teardown.test.ts   # 29 pass in isolation, 27 fail in suite
bun --no-orphans test engine/test/operations/app-resolution.test.ts           # 12 pass in isolation,  3 fail in suite
bun --no-orphans test engine/test/subsystems/host-proxy/transport.test.ts     # 27 pass in isolation,  3 fail in suite
bun --no-orphans test engine/test/cache/planning-runtime.test.ts              #  1 pass in isolation
bun --no-orphans test core/test/subsystems/host-proxy/shim-bin.test.ts        #  1 pass in isolation
bun --no-orphans test plugins/service-lando/test/go.scenario.test.ts          #  5 pass in isolation
bun --no-orphans test test/scenarios/generated/guides/apache/happy-path.test.ts
```

Every generated guide-scenario failure is the same `GuideFixtureNotFoundError`,
and the candidate paths name the cause outright:

```
candidates: [ "/tmp/lando-at-race-left-hvAtX1/docs/guides/apache/fixtures/apache-demo", … ]
```

`/tmp/lando-at-race-left-*` is created only by
`engine/test/operations/app-resolution.test.ts`, in `serializes same-root
resolution while another chdir region is active`. That test starts two
`loadUserLandofileAt` resolutions without awaiting them, and its `finally`
releases the parked fibers and then removes both temp roots without waiting for
them to settle. A released fiber resumes during the `rm`, runs the
`withResolvedCwd` release that chdirs back into the left root, and the `rm`
deletes that directory underneath it. The process spends the rest of the run
with its cwd on a removed path, so every later fixture lookup and every later
`withResolvedCwd` caller either misresolves or blocks on the held
`cwdResolutionLock` permit and times out at 5,000 ms.

**Queued, deliberately not fixed here.** It is one mechanism but three surfaces
— the `withResolvedCwd` primitive in `landofile/src/app-resolution.ts`, the
engine test harness that abandons fibers, and the cwd-relative fixture resolver
that turns the leak into 155 identical errors. Absorbing it into a measurement
story is the grouping this work exists to avoid.

`engine/test/subsystems/host-proxy/transport.test.ts`'s `closes the listener when
chmod fails after bind` is separately flaky on an unmodified `main`, racing a
`setInterval(…, 0)` socket remover against bind/chmod. It is **queued on its
own**, not counted in the 187 chdir residual.

## Named candidates

| File | Disposition |
| --- | --- |
| `core/test/cli/uninstall-runtime-service.test.ts` | Reproduced; **resolved** — host `/etc` escape in the test sandbox |
| `core/test/app/resolve.test.ts` | Reproduced, 9 failures; **queued as US-661** |
| `plugins/renderer-lando/test/transcript-tail-reader.test.ts` | **Does not reproduce** — 10 pass, 0 fail alone, and it reported no failure in the whole-suite run either |
