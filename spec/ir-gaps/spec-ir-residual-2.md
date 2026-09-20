# Spec: IR residual defects, second wave

Status: authored design, pre-implementation. Normative for priorities 63..71 in this directory. The thirty stories at priorities 21..62 are shipped; this document covers the defects their QA, review, and babysit passes recorded without queueing, plus the maintainer and CI items that the first residual wave deferred to a checklist.

## 1. Goal

Every finding below was observed during the verification of an earlier story, ruled out of that story's scope, and written to `progress.txt` without an owner. Each was re-confirmed against current source before being specified here, and two did not survive that re-confirmation (§10). None is carried forward on the strength of the log alone.

The first residual wave found one shape: a surface correct for its primary caller failing for a second caller that arrives through a different path. This wave finds a different one. Five of these defects are a **promise made in one place and kept in another**: a flag list advertises five output formats while one is honored; an audit file records six launchers as broken while one was fixed; a teardown reports services it did not remove; a volume selector is written two ways and read one way; a doctor record is written by one command and never revalidated by the two that most obviously invalidate it. The specification for each is therefore a statement about closing the distance between the promise and the keeping, not a request for a new feature.

## 2. Decisions (recorded)

These decisions are closed and bind the stories:

1. **An advertised format is an honored format.** A value in `RESULT_FORMATS` appears in every command's `--format` option list, in `lando help`, and in the generated command-registry manifest. A command that accepts such a value and emits something else has lied to a program. Either the boundary honors the value for every command, or the value is not advertised for that command.
2. **The machine formats derive from one encoded envelope.** `yaml` and `ndjson` are projections of the same `encodeCommandResult` output that `json` already produces, serialized through `@lando/sdk/yaml`. They are not a second per-command rendering surface. This extends the first wave's "one YAML emitter" decision (`spec-ir-residual.md` §2.5) from Compose export to command output.
3. **A planned service user applies to the whole start command — for every service type.** The first wave settled this for `apache` alone (`spec-ir-residual.md` §2.3). A service type MUST NOT emit a default command that only succeeds as `root` while its own catalog accepts a non-root `user:`. The audit file that records the remaining six is a work list, not a permanent disclosure.
4. **A service that names a port serves on it.** Where a bundled launcher generates the daemon's listen configuration, that configuration MUST derive from the planned `port:`. A launcher that derives endpoints and healthchecks from `port:` while hardcoding the daemon's own listen value describes a service that does not exist.
5. **Teardown reports only what it removed.** A teardown result naming a service it did not stop is worse than a teardown that removes nothing, because it ends the user's investigation. Observed orphan resources are removed by observed identity or they are not reported as removed.
6. **One ownership selector.** A volume's ownership identity is written one way and read the same way. A fallback that substitutes a raw filesystem path for a hashed identity is a pre-ship shim, and pre-ship is now.
7. **A persisted diagnostic is revalidated by whatever could invalidate it.** A record that says "the router's file watcher failed" MUST be re-observed or cleared by every command that restarts the router, not only by the command that first wrote it.
8. **A gate that cannot run is a failing gate.** A pipeline step that exits non-zero every time for days is not a skip. Its owner is identified and the handoff recorded, even when the owner is outside this repository.

## 3. Non-goals

- **Host port acquisition and the `80`/`443` fallback.** Owned by [`../alpha/prd-alpha-08-proxy-host-ports.md`](../alpha/prd-alpha-08-proxy-host-ports.md) (US-601..US-606), which already specifies the try lists, persistence, Traefik publication, doctor occupancy warnings, and the leftover-detection path. §9 records one new source fact for that PRD and hands it over; it opens no scope here.
- **Editing external workspace automation.** §8.3 identifies an owner and records a handoff. It does not modify a gate this repository does not contain.
- **Cross-app hostname ownership, a global route registry, or route-rank policy.** Settled by US-647; unchanged.
- **Widening any public error shape.** Every story here changes when an error is raised or what a surface emits, not what a tagged error *is*. §4 adds no error; §5 and §6 raise existing ones earlier or on more paths.
- **The `table` result format as a machine contract.** `table` is a human rendering. §4 keeps it on the render path and narrows its advertisement rather than promoting it.

## 4. Advertised result formats

### 4.1 Present behavior

`RESULT_FORMATS` declares five values, and `universalFormatFlagDefs` attaches the full list to every command:

- `core/src/cli/format-flags.ts` — `RESULT_FORMATS = ["text", "json", "table", "yaml", "ndjson"]`, and `universalFormatFlagDefs.format` with `options: [...RESULT_FORMATS]`
- `core/src/cli/cli-help.ts` — merges `universalFormatFlagDefs` into every rendered help page
- `core/src/cli/compiled-argv.ts` — merges the same defs into compiled-mode parsing
- `scripts/build-command-registry-manifest.ts` — emits the same option list into the generated manifest for every command

`extractFormatFlags` validates the value against that list, so all five are accepted and none is rejected.

The command boundary then branches on exactly one of them. `core/src/cli/renderer-boundary.ts` tests `renderContext.format === "json"` at every decision point — machine emitter selection, stream-frame sink construction, warning capture, and error rendering. No other value is consulted. Every non-`json` format falls through to the command spec's own `render`.

Five commands compensate by hand inside their own spec or render function:

| Command | Formats it implements itself |
|---|---|
| `meta:doctor` | `yaml`, `ndjson` |
| `meta:config` | `json`, `yaml`, `table` |
| `meta:global:config` | `json`, `yaml` |
| `app:config` | `json`, `yaml`, `table` |
| `app:config:translate` | `yaml`, `table`, `json` |

Every other command silently renders its text form for `--format=yaml`, `--format=ndjson`, and `--format=table`, and exits 0.

Observed on the binary (US-645 Verify): `lando info --format=yaml` emits the tab-separated info view. `app:info` declares no `format` handling at all — `infoSpec.render` calls `renderInfoAppResult`, which returns either a decorated summary or TSV rows.

### 4.2 Required behavior

`yaml` and `ndjson` become boundary-owned machine formats, derived from the encoded command-result envelope rather than from each command's renderer.

1. A command run with `--format=yaml` MUST emit the same envelope `--format=json` emits for that command, serialized through the `@lando/sdk/yaml` policy US-645 established. Parsing that YAML MUST yield the same model the JSON parses to.
2. A command run with `--format=ndjson` MUST emit the stream-frame sequence, one JSON document per line, for every command — not only those that already stream.
3. Redaction, `--json` field projection, `--jq`, warning capture, and the broken-pipe exit policy MUST apply to `yaml` and `ndjson` exactly as they apply to `json`. These are one seam, not three.
4. `table` stays a render-path value. It MUST be advertised only by commands that implement it, and MUST NOT appear in the universal flag defs. A command that does not implement `table` MUST reject `--format=table` with the existing `RendererSelectionError` rather than silently emitting text.
5. The five hand-rolled implementations are reconciled against the boundary. Where a command's bespoke YAML is the envelope in a different shape, the bespoke path is deleted. Where it is a genuinely different document — `meta:doctor`'s report projection is the likely case — it stays, and the story records why in the command spec.
6. `--format=text` keeps its meaning and stays the default.

The advertisement and the honoring MUST move together: no intermediate revision may advertise a format the boundary does not honor, because the generated command-registry manifest is consumed by MCP clients.

**Decomposition.** This lands as two stories. Adding `yaml` to the boundary (1, 3, 5, 6) is one mechanism against one seam. Narrowing what each command advertises (2, 4) is a different mechanism — a per-command format capability — and it regenerates the command-registry manifest for every command, which is broad golden churn that must not ride along with a semantic change. `ndjson` belongs to the second story, not the first: for a command that does not stream there is no frame sequence to emit, so the honest resolution is to stop advertising it there rather than to invent one.

## 5. Default start commands and the planned service user

### 5.1 Present behavior

`plugins/service-lando/DEFAULT_COMMAND_AUDIT.md` records six modes as `needs-fix`. All six were re-confirmed against current source, and the recorded write targets are accurate:

| Mode | Builder | Writes at container start |
|---|---|---|
| `php:*` via `apache` | `php-via.ts` `apacheStartCommand` | `/usr/share/lando/errors/{403,404}.html`, `/etc/apache2/sites-available/000-default.conf` |
| `php:*` via `fpm` | `php-via.ts` `fpmStartCommand` | `/usr/local/etc/php-fpm.d/zz-lando-listen.conf` |
| `nginx` with `backend:` | `nginx.ts` `phpFastcgiCommand` | `/usr/share/lando/errors/*`, `/etc/nginx/conf.d/default.conf` |
| `static` / `static:nginx` | `static.ts` `defaultStaticCommand` | `/usr/share/lando/errors/*`, `/etc/nginx/conf.d/default.conf` |
| `solr` with `cores:` | `solr.ts` `PRECREATE_WITH_CONFIG_SCRIPT` | `mkdir -p /var/solr/data/<core>/conf`, `cp -a /etc/lando/solr/conf/. /var/solr/data/<core>/conf/` |
| `minio` | `minio.ts` `defaultServerCommand` | `mkdir -p /data/$MINIO_BUCKET` |

The shared error-page writer is `http-errors.ts` `landoErrorPageSetupLines()`, which emits `mkdir -p /usr/share/lando/errors` plus two heredoc `cat >` writes. Three of the six call it.

All six apply the authored identity through the same one-line pattern — `if (service.user !== undefined) ctx.setUser(service.user)` — so the generated command runs as that principal. `setUser` writes `draft.user` (`engine/src/services/feature.ts`), which finalizes onto `ServicePlan.user`.

`static:caddy` is already write-free. `solr` without `cores:` and `nginx` without `backend:` install no Lando write.

The precedent is `apache.ts` `apacheStartCommand`, fixed by US-644: no shell, no writes, directives passed as repeated `-c` arguments, plus `-c 'PidFile "/tmp/lando-httpd.pid"'` because Apache's compiled default pid path is root-owned.

### 5.2 Required behavior

Each of the six MUST start successfully under a non-root `user:` that exists in its image, and MUST keep serving what it served before.

1. Where the daemon accepts the configuration on its command line, the launcher MUST pass it there and write nothing. This is the US-644 shape and is the preferred resolution.
2. Where the daemon requires a file, the launcher MUST write it to a path the planned user can write, and MUST point the daemon at that path explicitly. Inventing a world-writable location inside a root-owned tree is not a resolution.
3. Where the write target is a data tree whose ownership comes from a volume (`solr` cores, `minio` bucket), the resolution MUST make the ownership correct rather than assume it. A service whose data tree cannot be owned by its planned user MUST refuse at plan time with a tagged error naming the service and the option, in the manner `HomePathCapabilityError` already refuses an unknowable home.
4. The generated error pages are shared by three launchers and MUST be resolved once, in `http-errors.ts`, not three times.
5. `DEFAULT_COMMAND_AUDIT.md` MUST end the story with no `needs-fix` row, and the file's reproduction section MUST still describe how to check a future addition. The audit is kept current, not deleted.
6. A regression MUST cover each mode under a non-root user through the planner, and the guide for each affected service MUST stop implying the launcher requires root.

Compose knobs are not available as an escape hatch: `findUnsupportedComposeKnob` fails closed when the active provider declares no `composeKnobs`, and `@lando/provider-docker` declares none. A feature-emitted knob would narrow which providers a bundled service supports.

**Decomposition.** The six modes do not share a resolution, so they land as three stories grouped by mechanism rather than by service:

| Story group | Modes | Mechanism |
|---|---|---|
| Directives | `php:*` via `apache` | Pass configuration as `-c` arguments, write nothing. Owns the shared `http-errors.ts` resolution the other groups consume. |
| Writable config path | `php:*` via `fpm`, `nginx` with `backend:`, `static`/`static:nginx` | The daemon requires a file; the file moves somewhere the planned user can write and the daemon is pointed at it. |
| Data-tree ownership | `solr` with `cores:`, `minio` | The write target is volume-backed; ownership is made correct, and an unownable tree refuses at plan time. |

The third group adds a tagged error to the plan-carrying unions, which this repository has repeatedly measured as a sixteen-union, repo-wide edit. It cannot share a pull request with a launcher rewrite.

## 6. Listen port and the planned service port

### 6.1 Present behavior

`ServiceConfig.port` is an optional number (`sdk/src/schema/landofile.ts`). Its effect today is uneven, and the re-confirmation narrowed this finding considerably: **most bundled launchers already honor it.**

| Mode | Listen value |
|---|---|
| `php:*` via `fpm` | derived — `listen = <port>` into `zz-lando-listen.conf` |
| `nginx` with `backend:` | derived — `listen <port>;` |
| `static` / `static:nginx` | derived — `listen <port>;` |
| `static:caddy` | derived — `--listen :<port>` |
| `solr` | derived — `solr-foreground -p <port>` |
| `minio` | API derived — `--address :<port>`; console hardcoded `9001` |
| **`apache`** | **not derived** — no `Listen` directive emitted; image default stands |
| **`php:*` via `apache`** | **not derived** — `<VirtualHost *:80>` hardcoded |

`addServicePortEndpoints` (`_port-helpers.ts`) turns `port:` into an internal endpoint when Compose `ports:` is absent, and each feature embeds the same value in its healthcheck. Routes bind to endpoint ports through `engine/src/planner/endpoints.ts`. So for `apache` and `php`-via-`apache`, `port:` moves the endpoint, the healthcheck, and the route target while the daemon keeps listening on 80.

That asymmetry is pinned by a current test, which is the contract this section changes:

```
plugins/service-lando/test/apache.test.ts
  "uses serviceName for endpoints and LANDO env"
  expect(apacheDirectives(plan.command).some((d) => d.startsWith("Listen "))).toBe(false)
```

### 6.2 Required behavior

1. `apache` MUST emit `Listen <port>` derived from the planned `port:`, through the same repeated-`-c` mechanism US-644 established.
2. `php:*` via `apache` MUST derive its `<VirtualHost *:<port>>` from the same planned value.
3. Because the image's own `httpd.conf` already contains `Listen 80`, adding a directive adds a second socket rather than replacing the first. The story MUST prove which of the two it produced and MUST land the resolution that leaves the service listening on the planned port and not on 80. Whether that is an image-config edit at build time, a `-c` that supersedes, or a generated config include is left to the story; the acceptance is behavioral.
4. The `apache.test.ts` assertion above MUST be replaced with a stronger one, not deleted: the emitted directives MUST contain `Listen` at the planned port, and a service with no authored `port:` MUST keep emitting byte-identical output to today.
5. `minio`'s console port stays fixed at `9001` for this wave and MUST be recorded as a known limit in the minio guide rather than silently left.
6. This section does not grant a privileged port. A non-root service still cannot bind below 1024, and the affected guides MUST say so plainly. Making `port:` real is what gives the author the working answer.

## 7. Teardown, ownership, and the router observation

### 7.1 Orphaned containers

**Present.** `engine/src/operations/orphan-teardown.ts` builds a `selectionPlan` whose `services` map is deliberately `{}`, then calls `provider.destroy({ app, plan })`. The observed `group.services` are pushed onto the reported `services` array. Bring-down iterates `Object.values(plan.services)`, which is empty, so no container is stopped or removed — while the result names every observed service as removed.

Orphan *volumes* are different and already correct: they are removed through `provider.removeVolume(volume.ref, generation)` by observed identity.

The three provider `destroy` implementations share a separate hazard: with no `target.plan` they fall back to `loadAppliedPlan(appId)` and, when that record is gone, return `Effect.void` — a silent success. Orphan teardown does not reach that path today because it always supplies a plan, but any future planless caller would.

**Required.**

1. Orphan container teardown MUST remove the observed containers by observed identity, through a provider-contract target that does not depend on the provider resolving its own applied plan. This is a change across all three bundled adapters.
2. Until a container is actually removed, it MUST NOT appear in the teardown result. A result that lists a service MUST mean that service was stopped and removed.
3. `provider.destroy` MUST NOT report success when it resolved no plan and took no action. A planless destroy that finds no record is an explicit no-op outcome, not `Effect.void` behind a success.
4. Orphan volume removal under `--volumes` MUST distinguish cache volumes from data volumes the same way planful bring-down already does through `pruneVolumeClasses`. Today the orphan path has no kind filter.

### 7.2 The ownership selector

**Present.** The four-part selector is built in four places as `volumeSelectorValue({ providerId, appId, ownerKey: plan.identity?.ownerKey ?? plan.root, volumeClass })` — `bring-up.ts`, `compose.ts`, and twice in `bring-down.ts`. `ownerKey` is a sha256 of the canonical app root (`engine/src/planner/app-identity.ts`); the fallback substitutes the raw path.

A second, unrelated ownership label exists in parallel: `dev.lando.volume-owner` set to `identity.appRoot` (`container-runtime/src/volume-observation.ts`), which is what `provider-docker`'s planful volume delete checks — not the selector.

No source comment marks either as a shim. The "pre-ship compatibility shim" wording exists only in the US-629 review note.

**Required.**

1. The `?? plan.root` fallback MUST be removed. A plan without `identity.ownerKey` is either migrated at read time or refused; it MUST NOT silently produce a selector in a second format that the matching read cannot recognize.
2. The relationship between `dev.lando.volume-selector` and `dev.lando.volume-owner` MUST be stated in one place and enforced: either one label is derived from the other, or the story records why both exist and which is authoritative for which operation.
3. Whatever remains MUST carry a source comment naming the invariant, so the next reviewer does not have to reconstruct it from a progress log.

### 7.3 The router watcher observation

**Present.** `observeWatcherStartup` (`plugins/proxy-traefik/src/proxy.ts`) runs at the end of `RouterService.setup`. It reads the Traefik log once, classifies it, and either clears the record or writes `<globalAppRoot>/proxy-traefik/watcher-diagnostic.json`. `RouterService.stop` also removes the file. The doctor check `router-file-watcher` reads it and never clears it.

`RouterService.setup` is reached from app start (`applyAppRoutes`), from `lando setup`, and from doctor's proxy fix. It is **not** reached from `meta:global:restart` or `meta:global:rebuild`: restart is `globalStop()` then `globalStart()`, and both touch only `provider.destroy` / `provider.apply`. Rebuild is install, destroy, build, apply. Neither observes the watcher nor clears the record.

The practical consequence, seen repeatedly across US-642 through US-647 verification: `lando global:restart` is the documented first remediation for an inotify-limit failure, and it is precisely the command that cannot clear the diagnostic it is told to fix.

**Required.**

1. `meta:global:restart` and `meta:global:rebuild` MUST re-observe the router's watcher startup and update or clear the persisted record, on the same terms as `setup`.
2. A remediation MUST NOT name a command that cannot affect the condition. If a command is listed as the first recovery step, running it successfully MUST clear the diagnostic.
3. The doctor check MUST keep reporting the record as an unrevalidated observation. This section makes the record fresher; it does not make doctor probe live.

## 8. Maintainer and CI

### 8.1 Unit-suite baseline

**Present.** `bun run test:unit` excludes only `**/*.integration.test.ts`. CI shards additionally exclude `NIGHTLY_TIER_TESTS` and paths covered by dedicated jobs.

Three files are named repeatedly in the log as pre-existing failures that reproduce on `main`:

- `core/test/cli/uninstall-runtime-service.test.ts` — five tests, temp dirs, no chdir, no explicit timeouts
- `core/test/app/resolve.test.ts` — ~22 tests, no explicit timeouts anywhere in the file, `withTempApp` / `withTwoTempApps` chdir into temp roots and `rm` them in `finally`, plus five tests that chdir mid-test deliberately
- `plugins/renderer-lando/test/transcript-tail-reader.test.ts` — temp dirs, no chdir, no timeouts, one test that counts open descriptors via `/proc/self/fd`

The recorded count of thirteen failures is a lead. It has never been re-measured on current source.

**Required.** Re-establish the baseline on a clean checkout first, then fix each reproducing failure as its own change with a failing test captured first. Never group unrelated failures under one cause.

**Decomposition.** "Measure, then fix each one separately" is not a pull request; it is a plan that produces pull requests. It lands as a measurement story whose deliverable is the recorded baseline plus one queued item per reproducing failure, and the measurement story fixes only what is self-contained. One item is already specifiable without measuring, because it was confirmed from source rather than inferred from the log: `resolve.test.ts`'s cascade — one timeout removes the temp dir and every later test in the file dies on `chdir` — MUST be addressed as an isolation defect in the harness, not by raising a timeout; any timeout that is raised carries a per-test comment justifying it. That is its own story.

### 8.2 Guide scenarios on windows-arm64

**Present.** `scripts/build-ci-workflow.ts` emits one guide-scenarios job per entry in `CI_PLATFORMS`, and hardcodes `timeout-minutes: 30` for all of them. It does not use the per-platform `timeoutMinutes` (35 for `windows-arm64`). `scripts/test-shards.ts` contains no tiering or exclusion for guide scenarios — they are a separate job family. The observed failure is the 30-minute cap reached with zero step output, cleared by a rerun of the identical commit.

**Required.** The job MUST produce enough output to distinguish a hang from slow progress before any timeout is changed. Raising the cap without that evidence converts a 30-minute red into a 35-minute red. Once the stall point is identified, the resolution belongs where the stall is; if it is the runner rather than the repository, the finding is recorded and the job is quarantined explicitly rather than left to flake.

### 8.3 The external Drift Audit gate

§8.2 and §8.3 land as **one** story. Separately each is too small to be a pull request, and they are the same defect wearing two hats: a pipeline step that does not say what happened. A job that hits its cap with zero output and a gate that exits 1 while being logged as "skipped" are both illegible outcomes, and the fix for both is to make the outcome legible before anything is tuned.


**Present, and confirmed external.** There is no `.looper/` directory in this repository, no package script named for a drift audit, and no `scripts/*audit*` file. The two in-repo drift gates are `check:codegen-drift` and `check:guide-drift`; `audit` is `bun audit`, a dependency vulnerability scan. The `[looper] gate skipped Drift Audit: gate: script exited with code 1` lines come from workspace automation this repository does not contain.

It has failed on every run since roughly US-631, so at least a dozen stories shipped with no drift audit.

**Required.** Identify the gate's real owner and record the handoff in this repository's contributing documentation, so the next contributor does not re-derive the same conclusion. Do not silently edit external automation. Distinguish a skipped gate from a failed one in whatever record is kept — the current log conflates them, which is why the failure survived twelve stories.

## 9. Host ports — handed to alpha-08

Every verify pass from US-614 onward recorded ports 80/443 occupied and the proxy falling back, with HTTP 404 on the fallback port while HTTPS served. One instance was a different server answering entirely (`nginx/1.26.3`).

Re-confirmation added one fact worth carrying: the `lando-proxy-https.socket` unit that was observed holding 443 is **Lando's own**, generated by `plugins/proxy-traefik/src/socket-proxy-units.ts` along with `lando-proxy-http.socket` and their paired services. It is not a foreign holder.

`../alpha/prd-alpha-08-proxy-host-ports.md` already owns the try lists, persistence, Traefik publication, and — in US-604 — leftover detection and `EADDRINUSE` handling against persisted state. That is where a Lando-owned socket unit surviving its proxy belongs. This wave opens no story for it and records the fact for that PRD.

## 10. Findings re-confirmed as absent

Two recorded findings did not reproduce and are retired rather than queued, per the convention that audit findings are leads and not present defects.

**`lando tag -- -x beta` reporting "Too many positional arguments"** (US-646). Re-tested on current source and on the compiled `core/dist/lando`, using a two-positional declaration with a defaulted second slot built from the flags-and-args guide fixture: `--`, `-- -x beta`, and `-- v1 beta` all bind correctly and exit 0. `parseToolingArgv` consumes a single leading `--` and continues, which is the behavior the finding claimed was broken. Retired.

**Ghost entries in `apps:list`** (US-614 Verify). Predates the teardown and inventory work at US-629 and was never re-reproduced afterward. Remains a lead in the maintainer checklist; not queued.

## 11. Evidence

| Section | Story | Failing test captured first |
|---|---|---|
| §4 | US-649 | A command with no bespoke format handling emits a non-YAML document for `--format=yaml` |
| §4 | US-658 | A command that implements neither `table` nor `ndjson` accepts both and exits 0 with text |
| §5 | US-650 | `php:*` via `apache` fails to start under a non-root `user:` present in its image |
| §5 | US-659 | Each nginx-family mode and `php:*` via `fpm` fails the same way |
| §5 | US-660 | `solr` with `cores:` and `minio` fail on a data tree their planned user cannot own |
| §6 | US-651 | An `apache` service with `port: 8080` emits no `Listen 8080` and does not serve on 8080 |
| §7.1 | US-652 | An orphan group reports a removed service while the container survives |
| §7.2 | US-653 | A selector written from a plan without `identity.ownerKey` is not matched by the reading side |
| §7.3 | US-654 | `global:restart` leaves a stale watcher record that doctor keeps reporting |
| §8.1 | US-655 | Re-measured baseline, per failure |
| §8.1 | US-661 | One timed-out test in `resolve.test.ts` kills every later test in the file |
| §8.2, §8.3 | US-656 | The guide-scenarios job reaches its cap with no output attributable to a step |

§5, §6, §7.1, and §7.3 change user-visible behavior on a real runtime and carry real-provider evidence at Verify. §5's evidence is a running service under a non-root user serving a response. §6's is a request answered on the planned port. §7.1's is a surviving container before and an absent one after.

§7.2, §8.1, §8.2, and §8.3 are maintainer-facing and carry internal evidence with no public guide.

## 12. Story sizing

One story is one pull request. This repository has a measured sense of what that means: across the thirty shipped stories the drift-audit triggers cluster at roughly 700 to 2,000 changed lines over 5 to 10 commits and 1 to 3 cycles. The two that exceeded it are the two that went wrong — US-617A at 6 cycles and 18 commits shipped `passes: false` twice and needed a 139-failure fixture sweep it had not budgeted, and US-629 at 4 cycles and 37 commits stayed red through two babysit rounds and ended in a deferred merge. A story projected above that ceiling is split before it is queued, not after it stalls.

Three findings here projected past the ceiling and one fell under the floor:

| Finding | Projected as one story | Resolution |
|---|---|---|
| §4 advertised formats | Two mechanisms plus a manifest regeneration for every command | Split into US-649 and US-658 |
| §5 non-root launchers | Six modes, three unrelated resolutions, one new error in sixteen unions | Split into US-650, US-659, US-660 |
| §8.1 unit baseline | Unbounded: "measure, then fix each" is a plan, not a pull request | Split into US-655 and US-661 |
| §8.3 gate ownership | A single documentation section | Merged into US-656 |

The remaining findings were left whole. §6, §7.1, §7.2, and §7.3 are each one mechanism against one seam, and §7.1 is at the upper end only because a provider-contract change necessarily touches three adapters and the frozen SDK surface together — splitting it would produce a revision where the contract exists and no provider implements it.

## 13. Open items

- §4 leaves the disposition of the five hand-rolled format implementations to the implementing story. `meta:doctor`'s report projection is the likely survivor; the other four are likely envelope duplicates. The story decides per command and records the reason.
- §6 leaves the mechanism for superseding the image's own `Listen 80` open. A `-c` directive, a generated config include, and a build-time edit all satisfy the requirement; they differ in whether the service ends up listening on one port or two, which is exactly what the story must prove.
- §7.2 may conclude that `dev.lando.volume-owner` and `dev.lando.volume-selector` should collapse into one label. That is an acceptable resolution and changes observed volume metadata, so it needs a migration path for volumes created by an earlier build.
- §8.2 may conclude the windows-arm64 stall is a runner defect with no repository-side resolution. Recording that with evidence closes the item.
