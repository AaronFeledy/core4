# PRD: Lando v4 IR gaps user stories

Global priorities, dependencies, and standard gates are recorded in the index and `prd.json`. Each story retains behavior for every config frontend.

## Guide Coverage

| Story | Feature | Guide or README |
|---|---|---|
| US-613 | tooling normalization and execution | `docs/guides/tooling/flags-and-args.mdx` |
| US-614 | task and restart events | `docs/guides/events/task-events.mdx` |
| US-615 | routes and filters | `docs/guides/proxy/route-shorthand.mdx` |
| US-616 | build users | `docs/guides/services/build-steps.mdx` |
| US-617A | home and host | `docs/guides/services/home-and-host.mdx` |
| US-617B | router and scanner | `docs/guides/services/router-and-scanner.mdx` |
| US-618A..US-618C | catalog options | affected recipe READMEs |
| US-618D1, US-618D3 | scoped commands and global defaults | `docs/guides/landofile/lando3-transition-options.mdx` |
| US-623 | tooling input consistency | `docs/guides/events/task-events.mdx`, `docs/guides/agent-native/mcp.mdx` |
| US-624 | routing correctness | `docs/guides/proxy/route-shorthand.mdx`, `docs/guides/services/router-and-scanner.mdx` |
| US-626 | redacted config view | `docs/guides/config/global-config.mdx` |
| US-628 | bounded scanner with live start verification | `docs/guides/services/router-and-scanner.mdx` |
| US-629 | teardown and inventory consistency | `docs/guides/tutorial/app-lifecycle.mdx`, `docs/guides/cli/everyday-commands.mdx` |
| US-631 | Solr core safety and copy contracts | `docs/guides/services/solr.mdx` |
| US-632 | provider-free event validation parity | `docs/guides/landofile/config-lint.mdx`, `docs/guides/events/task-events.mdx` |
| US-633 | label fidelity | `docs/guides/config/global-config.mdx`, `docs/guides/config/compose-compatibility.mdx` |
| US-635 | reproducible msmtp | `docs/guides/services/mailpit.mdx` |
| US-637 | canonical home destinations and verified metadata | `docs/guides/services/home-and-host.mdx` |
| US-638 | live file-backed catalog config verification | maintainer-only: isolated live tests, no public guide |
| US-642 | router file-watcher diagnostics | `docs/guides/global/doctor-walkthrough.mdx` |
| US-643 | teardown independent of desired config | `docs/guides/tutorial/app-lifecycle.mdx`, `docs/guides/cli/everyday-commands.mdx` |
| US-644 | Apache under a non-root service user | `docs/guides/services/apache.mdx` |
| US-645 | durable machine output | `docs/guides/scripting-with-json.mdx` |
| US-646 | positional tooling argv round trip | `docs/guides/tooling/flags-and-args.mdx`, `docs/guides/agent-native/mcp.mdx` |
| US-647 | cross-app route rank safety | `docs/guides/proxy/route-shorthand.mdx` |
| US-648 | live provider socket gate | maintainer-only: test infrastructure, no public guide |
| US-649 | YAML from the result envelope | `docs/guides/scripting-with-json.mdx` |
| US-658 | per-command format advertisement | `docs/guides/scripting-with-json.mdx` |
| US-650 | Apache PHP launcher under a non-root user | `docs/guides/services/php.mdx` |
| US-659 | nginx-family and FPM launchers under a non-root user | `docs/guides/services/nginx.mdx`, `docs/guides/services/static.mdx`, `docs/guides/services/php.mdx` |
| US-660 | volume-backed data trees under a non-root user | `docs/guides/services/solr.mdx`, `docs/guides/services/minio.mdx` |
| US-651 | Apache listen port from `port:` | `docs/guides/services/apache.mdx`, `docs/guides/services/php.mdx` |
| US-652 | orphan container teardown | `docs/guides/tutorial/app-lifecycle.mdx`, `docs/guides/cli/everyday-commands.mdx` |
| US-653 | volume ownership selector | maintainer-only: internal volume metadata, no public guide |
| US-654 | router observation on global lifecycle | `docs/guides/global/doctor-walkthrough.mdx` |
| US-655 | unit-suite baseline | maintainer-only: test infrastructure, no public guide |
| US-661 | resolve-test isolation cascade | maintainer-only: test infrastructure, no public guide |
| US-656 | pipeline gate legibility | maintainer-only: CI and contributing docs, no public guide |

### US-613: Normalize and execute tooling definitions

**Description:** As a tooling author, validated metadata and ordered steps behave consistently across every projection and execution target.

**Acceptance Criteria:**
- [ ] Extend the schema for user, disabled, flags, args, and ordered step objects; normalize alias, choices, boolean, default, requiredness, and positional order once before native command creation.
- [ ] Reuse that schema for native aliases/options/types, CLI help, machine index, cache, and MCP; stale cache cannot bypass disabled prechecks, and accepted/unsupported schema plus applicable standard gates pass.
- [ ] Execute mixed string/object steps in order, resolve `:<flag>` from validated values, route `:host` through the host engine without provider initialization, and honor task/step user and directory precedence.
- [ ] Reject unknown services, missing dynamic flags, invalid args, disabled direct/stale-cache calls, and unsupported fields with tagged source-aware errors; CLI/MCP parity, guide, and applicable standard gates pass.

### US-614: Resolve dynamic and nested task events

**Description:** As a Landofile author, task and restart events validate and fail consistently.

**Acceptance Criteria:**
- [ ] Extend event names from fully resolved layered/included tooling before semantic validation, add restart brackets, report the complete valid set, and bound nested command-event recursion with visited-stack cycle and depth rejection.
- [ ] Preserve event order and primary-service default; pre/body/post follow command semantics and post-step failure is fatal with redacted tail; guide and applicable standard gates pass.

### US-615: Implement route shorthand and filters

**Description:** As a Landofile author, concise routes lower to provider-neutral explicit middleware.

**Acceptance Criteria:**
- [ ] Normalize host, port, path, wildcard, and combined shorthand; implement strip/add prefix, request/response header, and redirect filters merged by name then type identity and rendered in authored order with no implicit stripping.
- [ ] Tagged invalid input, schema/merge/filter contracts, Traefik goldens, real routing evidence, guide, and applicable standard gates pass.

### US-616: Resolve per-step build users in planning

**Description:** As a service author, each artifact and app build step runs as its planned user.

**Acceptance Criteria:**
- [ ] Accept string or `{run,user?}` steps, resolve omitted users per service during planning, and carry every resolved user through `BuildPlan`, provider execution, and ordered build-key hashing.
- [ ] Artifact generation switches USER only when needed and restores the final service USER; app steps pass explicit users; root/interleaved/provider/guide and applicable standard gates pass.

### US-617A: Add home persistence and host reachability

**Description:** As a user, service home persists only when its path is knowable and supported containers can reach the host.

**Acceptance Criteria:**
- [ ] Define `home: false | {path?: AbsoluteContainerPath}` with default enabled: known catalog user/home metadata creates one idempotent service-scoped store; custom/compose images lacking known USER/HOME fail `HomePathCapabilityError` before provider action unless disabled or given an explicit path.
- [ ] Deduplicate equivalent authored storage, preserve ownership, exclude changing contents from build keys, and realize host alias/IP only from declared capability and known gateway data; guide, real runtime, and applicable standard gates pass.

### US-617B: Honor router disablement and scan startup URLs

**Description:** As a user, router disablement and post-start URL scanning affect real behavior.

**Acceptance Criteria:**
- [ ] Resolve router enablement through normal precedence; false prevents router startup/publication and info reports only published endpoints.
- [ ] Add `scanner: false | {path?, okCodes?, retries?, timeout?}` and run bounded post-start `UrlScanner` through `runProbe`; redact errors and warn without failing start; real route/scan, guide, and applicable standard gates pass.

### US-618A: Implement file-backed catalog configuration

**Description:** As a catalog user, service config files have fixed typed destinations and startup behavior.

**Acceptance Criteria:**
- [ ] Add `solr.config.dir` mounted read-only as the config source copied into each declared core's `/var/solr/data/<core>/conf`, plus `config.server` for PostgreSQL at `/etc/lando/postgresql.conf` with `-c config_file=...`, MySQL/MariaDB at `/etc/mysql/conf.d/99-lando.cnf`, and MongoDB at `/etc/lando/mongod.conf` with `--config`.
- [ ] Validate app-relative regular sources, containment and symlink safety before provider action; source identity enters plan/build keys; golden plans, real config loading, README, and applicable standard gates pass.

### US-618B: Implement Node and PHP package options

**Description:** As a catalog user, global Node tools and Composer version/packages build deterministically.

**Acceptance Criteria:**
- [ ] Implement deterministic `node.globals` and additive PHP `composer: {version, packages}` while preserving string and false forms; normalize package order and validate versions.
- [ ] Hash commands, resolved users, versions, packages, and sources while redacting secrets; unchanged-build, real invocation, README, and applicable standard gates pass.

### US-618C: Implement Redis and Mailpit behavior

**Description:** As a catalog user, Redis auth/persistence and Mailpit sender wiring work end to end.

**Acceptance Criteria:**
- [ ] Apply Redis password to startup, healthcheck, creds, tooling, and redaction and use `persist` for durable versus ephemeral data intent.
- [ ] Add Mailpit `mailFrom?: false | ServiceName[]`: omitted targets every resolved PHP service, false targets none, arrays dedupe in authored order and reject unknown/non-PHP names; only targets receive sendmail wiring; real runtime/mail, README, and applicable standard gates pass.

### US-618D1: Add service-scoped rebuild and info

**Description:** As a user, I can rebuild or inspect selected services with each command's exact dependency semantics.

**Acceptance Criteria:**
- [ ] For rebuild, add repeatable `--service/-s` and library/MCP `services?: ServiceName[]`, dedupe first occurrence, validate every name before provider action, and compute selected services plus transitive `dependsOn` prerequisites in stable topological plan order.
- [ ] Stop, force-build, and restart exactly that closure, including already-running prerequisites, while unrelated services and dependents remain untouched; CLI/library/MCP, provider closure, guide, and applicable standard gates pass.
- [ ] For info, add repeatable `--service/-s` and library/MCP `services?: ServiceName[]`, dedupe first occurrence, validate all names before inspection, and select no dependencies.
- [ ] Return the existing schema-stable info shape in app-plan order for selected services only; empty selection retains all-services behavior; CLI/library/MCP, guide, and applicable standard gates pass.

### US-618D3: Add bounded global app environment and labels

**Description:** As a user, bounded v4 global defaults apply only to user-app services and never override service-authored values.

**Acceptance Criteria:**
- [ ] Add `appEnv` and `appLabels` only to v4 global config: config layers deep-merge low to high, environment overrides replace the whole map, and each user-app service's authored map wins; never apply to global/scratch apps or import Lando 3 global state.
- [ ] Limit each map to 256 entries; env keys are POSIX identifiers, values at most 32 KiB, encoded map at most 1 MiB, and the exact generated catalog of core-owned `LANDO`/`LANDO_*` keys is reserved rather than an ad hoc wildcard; label keys are 1..253 bytes without NUL or `=`, values at most 4 KiB, map at most 256 KiB, and `dev.lando.*` is reserved; redaction, guide, and applicable standard gates pass.

### US-618E: Honor Apache/Node fields and enforce catalog versions

**Description:** As a service user, authored webroot/port values work and unavailable runtimes fail closed.

**Acceptance Criteria:**
- [ ] Apache uses authored webroot for generated config/routes and Node uses authored port for endpoints, health, and generated commands.
- [ ] Make ServiceType version metadata the single shipped matrix used by planner validation, generated docs, and tests; reject unknown/absent versions including unavailable old PHP images with tagged remediation; supported real-runtime, rejection, README, and applicable standard gates pass.

## Follow-up stories (US-623..US-642)

These stories come from an audit of the stories above. Audit findings are historical evidence: they point at where to look, not proof that a defect exists on current source. Each story starts by reproducing on a clean checkout and locking the behavior with a failing test before any fix.

One story is one pull request. The audit first produced twenty follow-ups; they were consolidated into these twelve PR-sized deliverables. Ids are sparse on purpose: each surviving story keeps the id it had before consolidation, and the retired ids (US-625, US-627, US-630, US-634, US-636, US-639, US-640, US-641) are absorbed into the story that now owns their scope rather than reopening the original work. Nothing from a retired entry was dropped; product scope moved into the absorbing story named in its notes, and maintainer scope moved to the checklist at the end of this file.

Shared gates for every follow-up: focused tests with a positive count, typecheck, lint, and boundaries, plus the schema, codegen, guide coverage, drift, and public transcript gates its acceptance criteria name. Live runtime evidence runs only in an explicit isolated sandbox under the existing runtime env gate. US-638 is the only maintainer-only story and records internal test output instead of a public guide.

### US-623: Make tooling inputs consistent across CLI, events, and MCP

**Description:** As a tooling author, a task receives the same validated inputs whether the CLI, an event step, or an MCP client invokes it.

**Acceptance Criteria:**
- [ ] Tooling `args` map definitions with an explicit declared order normalize once, in the tooling normalization module, into one ordered native argument declaration; event-step serialization consumes that same ordered declaration rather than object-key order, so a declared order that differs from key order yields identical argv on the CLI path and the event path, including the `--` delimiter before positionals that begin with a hyphen.
- [ ] Schema decode runs before serialization on every path and test fixtures are decoded values rather than raw objects; a task with no declared inputs still receives its raw authored argv byte-identical after normalization.
- [ ] One shared projection and validation path owns integer flag metadata for CLI, library, and MCP; the MCP catalog emits `integer` for inputs such as `logs --tail` instead of `number` or `string`.
- [ ] A real `logsSpec` tail request through the MCP transport accepts a JSON integer and rejects fractional and string-typed values with a tagged error that names the offending input; non-finite values, which JSON cannot encode, are rejected at the direct validator boundary by a unit test against the shared validator.
- [ ] Existing tagged error contracts on each surface are preserved; where the CLI and MCP contracts differ by design, tests assert each surface's own tag. Direct CLI, event-step, and MCP invocation of the same task produce the same argv and the same exit outcome, asserted as cross-surface equality rather than per-surface snapshots.
- [ ] Failing regression tests first lock the current declared-order divergence and the current integer projection mismatch; focused tests with a positive count, the task-events and MCP guides, typecheck, lint, boundaries, and command-schema codegen gates pass.

### US-624: Preserve route identity and define route specificity

**Description:** As a Landofile author, several routes on one host keep their distinct match identities, overlapping routes resolve in one documented order, and real requests reach the backend the plan names.

**Acceptance Criteria:**
- [ ] Routing-match identity is scheme, host, port, and path; distinct match paths on the same host, or the same host and path on `http` versus `https`, survive lowering as separate routes in the planner output without changing the existing layer merge law.
- [ ] Two routes with the same match identity dedupe to one route only when their backend and filters are semantically equivalent; the same match identity with a different backend or filter set fails with a tagged source-aware error before any provider action, and nothing collapses silently.
- [ ] One explicit specificity policy is defined once in the planner: exact hosts outrank wildcard hosts, then longer path prefixes outrank shorter ones, and a diagnostic fallback route always ranks lowest; the Traefik renderer projects that policy as router priorities instead of relying on Traefik's default ordering, and two routes tied on every dimension either fail with a tagged error or resolve by one documented deterministic rule that is tested.
- [ ] Real routing evidence in an isolated sandbox starts an app under fallback ports with an overlapping exact host, a wildcard host, a differing path, and `http` versus `https` routes, and proves each request reaches the intended backend by responder identity; the same evidence proves a disabled router publishes nothing and `lando info` reports host-only endpoints.
- [ ] The HTTPS default is preserved and an HTTP 404 on an HTTPS-only route is a documented diagnostic outcome with remediation, not a defect; existing single-route fixtures keep their semantics, proven by planner and routing tests rather than byte-identical YAML, since goldens gain priority fields.
- [ ] A failing regression test first captures the current same-host collapse; the route-shorthand guide documents identity and ordering with a runnable example and the router-and-scanner guide documents scheme semantics on fallback ports; focused tests with a positive count, typecheck, lint, boundaries, and applicable codegen gates pass.

### US-626: Complete redacted config view and get

**Description:** As a user, `lando config` and `lando config get` show the whole intentional public effective config, including `appEnv` and `appLabels`, with secrets redacted.

**Acceptance Criteria:**
- [ ] The read projection for `lando config` and `lando config get` comes from the canonical config loader and one result schema owned by `ConfigService`; neither command assembles its own view, and no separate config dump command is added.
- [ ] The view includes every intentional public key, including the `appEnv` and `appLabels` maps, and excludes internal-only state; it is a curated public projection, never a raw dump of internal config.
- [ ] `lando config set` followed by `lando config get` round-trips each map, and the full `lando config` view and its encoded output show the same values, so set, get, and full view have encode parity.
- [ ] Secret values are redacted through the canonical `RedactionService` before rendering in every output mode, and the result schema ships with the schema snapshot codegen.
- [ ] A failing regression test first proves the maps are missing from `lando config get` today; the global-config guide shows the maps in `lando config` output; focused tests with a positive count, typecheck, lint, boundaries, and schema snapshot gates pass.

### US-628: Bound the scanner and verify live start scanning

**Description:** As a user, post-start URL scanning stays bounded in time, memory, and concurrency, local targets follow an explicit proxy policy, and a live start proves the scanner really runs.

**Acceptance Criteria:**
- [ ] Each scanner status read runs inside a `Scope` and reads only the status line and headers; cancelling the scan aborts in-flight response streams, and no probe buffers a full response body.
- [ ] Scanner concurrency is bounded by an explicit limit, and the scan deadline is enforced with real elapsed timing so diagnostics report actual wait time rather than the configured value.
- [ ] Proxy handling for local scan targets is declared in the existing network trust seam of `@lando/http-client` as an explicit local-endpoint policy; no blanket domain or caller bypass is added, and remote proxy trust, custom CA, and cancellation behavior are unchanged.
- [ ] A permanent isolated live test proves that `lando start` invokes the scanner against the actual published URL, that a failing scan warns while start still succeeds, and that interruption during the scan propagates; it cleans up its app and provider resources in a `Scope` and runs serially under the existing runtime env gate. An existing current permanent test satisfies an item; a one-off log capture does not.
- [ ] Failing regression tests first capture unbounded reads and missing timing; focused tests with a positive count, the router-and-scanner guide, typecheck, lint, and boundaries pass.

### US-629: Tear down from applied state and keep inventory consistent

**Description:** As a user, `lando destroy` and `lando stop` work when the current Landofile is invalid or missing, and app inventory reflects reality afterwards without deleting live resources on a guess.

**Acceptance Criteria:**
- [ ] Destroy and stop resolve the target app from the validated last-applied state record when the desired config fails to load or is absent; the operation never requires re-planning the desired config to tear down owned resources.
- [ ] Ownership, canonical app root, and provider identity checks against the applied record fail closed with tagged errors when they do not match the invoking context; no generic force flag skips those checks.
- [ ] An app that was never started and owns no resources returns an explicit idempotent outcome rather than an error, and repeating the command yields the same outcome.
- [ ] A successful destroy clears the app's applied record and its discovery and inventory cache entries in the same operation; roots that no longer exist are marked stale and reported as such, and a missing root never by itself authorizes deletion of live resources or state records.
- [ ] A bounded prune of stale inventory entries runs only after the provider confirms no owned resources remain for that app, and the prune reports exactly which entries it removed.
- [ ] Failing regression tests first prove the current invalid-config teardown failure and the surviving inventory entry after destroy; focused tests with a positive count, a real-runtime destroy after config corruption in an isolated sandbox, the app-lifecycle tutorial, the everyday-commands guide, typecheck, lint, and boundaries pass.

### US-631: Validate Solr core names and lock config copy contracts

**Description:** As a Solr user, core names cannot escape the data directory, and the config copy and build-key rules are documented contracts.

**Acceptance Criteria:**
- [ ] Core names equal to `.` or `..`, or containing a slash or backslash, are rejected before any command generation with a tagged source-aware remediation; names such as `a.b` or `a...b` that are otherwise valid stay accepted.
- [ ] Generated shell for accepted core names such as `a.b` and `a...b` keeps its existing quoting, proven by a golden; names containing spaces or shell metacharacters remain rejected by the schema.
- [ ] The overlay copy semantics into each core's `conf` directory and the stable build-key hash for an empty `solr.config.dir` are documented as intentional in the Solr guide and locked by tests, not treated as defects.
- [ ] A failing regression test first proves the current path traversal acceptance; focused tests with a positive count, the Solr guide, typecheck, lint, and boundaries pass.

### US-632: Share event resolution between lint, doctor, and start

**Description:** As a Landofile author, `lando config lint` and `lando doctor` recognize exactly the events that `lando start` will run, without touching a provider.

**Acceptance Criteria:**
- [ ] Service tooling and event names resolve through one shared resolution function that performs no provider initialization or provider action; lint, doctor, and start all call it and report the same known event set.
- [ ] Invocable tasks from the service, every config layer, and every include contribute to the known set identically on every surface, while include-only internal tasks that cannot be invoked are excluded on every surface; a failing regression test first shows the surfaces disagreeing today.
- [ ] When resolution itself fails, lint and doctor surface the tagged resolve error rather than reporting a false unknown-event diagnostic.
- [ ] Focused tests with a positive count, the config-lint and task-events guides, typecheck, lint, and boundaries pass.

### US-633: Keep label secrets redacted and Compose export keys intact

**Description:** As a user, secrets inside label and environment values stay redacted whatever separators the key uses, and exported Compose keys and values survive a YAML round trip.

**Acceptance Criteria:**
- [ ] `@lando/redaction` remains the only redactor; tokenization treats dot, hyphen, and underscore as separators when matching secret keys so `com.example.password`, `dev.example.db-password`, and `DB_PASSWORD` all match, and label and environment rendering keep calling the canonical `RedactionService` with no label-specific or env-specific redactor.
- [ ] Regression canaries include dotted, hyphenated, and underscored secret keys alongside non-secret labels that must remain visible; the existing short-token policy stays in force and is asserted.
- [ ] The Compose export serializer quotes keys and values that YAML would otherwise reinterpret, including keys with colons, leading special characters, and values that read as numbers, booleans, or null; a round-trip test parses exported YAML for every supported odd key shape and compares it structurally to the source model.
- [ ] Runtime application through the provider API is unchanged and still bypasses YAML; there is one serializer for export and no second implementation.
- [ ] Failing regression tests first capture the unredacted dotted label and a broken exported key; focused tests with a positive count, the global-config and compose-compatibility guides, typecheck, lint, and boundaries pass.

### US-635: Acquire msmtp reproducibly per base image family

**Description:** As a PHP user, Mailpit sendmail wiring installs msmtp from a pinned, reproducible source for each supported PHP base image family.

**Acceptance Criteria:**
- [ ] msmtp acquisition is keyed by the selected PHP image's supported base family and installs from a pinned repository snapshot or a checksum-verified asset; the pin identity enters the build key.
- [ ] A documented update process regenerates the pins per family; the change does not re-pin every base image or force one distro version across families.
- [ ] A real build of the selected PHP images sends mail through Mailpit as a non-root user, and a failing regression test first captures the unpinned install.
- [ ] Focused tests with a positive count, the Mailpit guide, typecheck, lint, boundaries, and applicable codegen gates pass.

### US-637: Canonicalize home destinations and verify shipped home metadata

**Description:** As a service author, container home destinations normalize predictably, and catalog home metadata matches the images Lando ships.

**Acceptance Criteria:**
- [ ] Container destinations normalize once as POSIX paths, resolving dot segments and trailing separators, so equality between `home` and storage paths compares canonical forms; `.`, `..`, and root as a destination follow one explicit documented policy.
- [ ] Colons are not rejected in destinations without a documented reason tied to provider mount syntax; the authored path round-trips through `lando app:config` where the existing contract shows it.
- [ ] Per-user Apache home metadata is added only after inspecting the shipped image's account data for that user, including its passwd entry home, not only the image's default `USER` and `HOME`; where no known home exists, the tagged `HomePathCapabilityError` refusal remains, unknown custom images stay fail-closed, and no path is guessed.
- [ ] A failing regression test first captures the non-canonical comparison; focused tests with a positive count, a real-runtime check of the verified home, the home-and-host guide, typecheck, lint, and boundaries pass.

### US-638: Verify file-backed catalog config on live daemons

**Description:** As a maintainer, every file-backed catalog config option has a permanent isolated live test proving the daemon actually loads the file.

**Acceptance Criteria:**
- [ ] MySQL, MariaDB, PostgreSQL, MongoDB, and Solr each have a permanent live test proving the daemon loads the mounted config file and reflects one observable setting from it, observed through the daemon itself rather than through mounted paths or generated commands alone.
- [ ] Every live test cleans up its app and provider resources in a `Scope` and runs serially as `*.integration.test.ts` under the existing explicit runtime env gate; an existing current permanent test satisfies an item, and plan-only or documentation-only proof does not count.
- [ ] Only targeted fixes for regressions these tests reproduce ride along, each with a failing test first; no general product implementation or sweeping service redesign is bundled.
- [ ] The story is bounded to this one test family: scanner evidence belongs to US-628 and router or scheme evidence to US-624. Focused tests with a positive count, typecheck, lint, and boundaries pass.

### US-642: Diagnose router file-watcher failures

**Description:** As a user, router and doctor tell me why the file provider failed to watch and what I can do without root.

**Acceptance Criteria:**
- [ ] Router startup and `lando doctor` surface file-provider watcher errors as tagged diagnostics that distinguish inotify limits from disk or permission failures and name the runtime host actually running the watcher.
- [ ] The remediation names a non-privileged action first; Lando never runs sysctl or restarts global services automatically.
- [ ] The failure is surfaced without logging secrets, using the canonical redaction path for any captured output.
- [ ] Deterministic tests inject each failure class; live evidence is recorded when a reproduction is feasible in an isolated sandbox; focused tests with a positive count, the doctor-walkthrough guide, typecheck, lint, and boundaries pass.

### US-643: Keep teardown independent of the desired config

**Description:** As a user, `lando stop` and `lando destroy` remove what is actually present, even when the Landofile no longer validates or plans.

**Acceptance Criteria:**
- [ ] Teardown resolves the app root from discovery and consults applied state plus runtime evidence for that root before it loads or plans the desired config; a never-started app whose Landofile fails validation or refuses at plan time returns `outcome: "unchanged"` with no provider action and exit 0, for both `stop` and `destroy`.
- [ ] Runtime resources whose recorded owner is the app root under teardown are removed as orphans of that root rather than refused; a plain `destroy` followed by `destroy --volumes` removes the retained data volumes instead of failing `AppResolveError` with `detail: "provider-resources"`, and the orphan teardown reports what it removed.
- [ ] Every non-teardown caller keeps the current fail-closed orphan refusal in the shared applied-state evidence resolver; the relaxation is scoped to teardown callers and is not implemented by widening that resolver's default, and `lando start` still refuses an unplannable app.
- [ ] `unchanged` stays distinguishable from `destroyed` in every renderer and in `--format=json`; no public error shape is widened.
- [ ] The existing assertion that teardown preserves the desired-config failure when no applied plan exists is deliberately replaced rather than deleted, with the new contract asserted in its place; failing regression tests first capture both the invalid never-started refusal and the blocked second `destroy --volumes`; focused tests with a positive count, the app-lifecycle and everyday-commands guides, real-runtime teardown evidence, typecheck, lint, and boundaries pass.

### US-644: Run the Apache default start command as the planned service user

**Description:** As a service author, `type: apache` with a non-root `user:` starts and stays running without an authored `command:` override.

**Acceptance Criteria:**
- [ ] An Apache service planned with `user: www-data` and no authored `command` or `entrypoint` applies as running and serves the configured `DocumentRoot`; the webroot configuration is not dropped, and the author is not required to supply a `command:` to work around it.
- [ ] The fix removes the root requirement from the default start path rather than documenting it; evidence is the running service and a served response, not the absence of `ServiceExecError` or `ServiceStartError`, since those tags depend on which operation runs next.
- [ ] A rebuild of that service succeeds rather than failing exec against a container that died on its own start command.
- [ ] Every other bundled service type that emits a default command is checked for the same pattern of writing outside the planned user's reach, and each is either fixed in this story or recorded with its reproduction; the service-type command surface is not redesigned.
- [ ] A failing regression test first captures the non-root Apache plan; focused tests with a positive count, the Apache service guide, real-runtime evidence of the running service, typecheck, lint, and boundaries pass.

### US-645: Make machine output survive a closed pipe and a YAML round trip

**Description:** As a script or agent author, I can pipe Lando's machine output into a short-lived consumer and parse the YAML it emits without either one corrupting.

**Acceptance Criteria:**
- [ ] A downstream consumer that closes the pipe early ends output cleanly on every renderer write path: no unhandled stream error, no internal-error report, no stack trace, and the conventional terminated-pipeline exit status; stdout and stderr are each handled independently because they can be redirected separately.
- [ ] One YAML scalar and key quoting policy serves both the Compose export serializer and the CLI config emitter; the hand-rolled unquoted emitter is deleted rather than kept beside the shared one, and the policy lives where both callers may import it under the package DAG.
- [ ] Every `--format=yaml` surface satisfies a round-trip law: parsing emitted YAML yields a document structurally equal to the source model, proven over the redaction sentinel, boolean-like and numeric-like strings, `null`-like strings, values containing `: `, and values with leading indicator characters — not over the redaction sentinel alone.
- [ ] Publishing the shared policy on a public SDK subpath is optional; if chosen it follows `sdk/AGENTS.md`, records the additive export, and refreshes the schema artifact set.
- [ ] Failing regression tests first capture the piped crash and at least one corrupted round trip; focused tests with a positive count, the JSON scripting guide, typecheck, lint, and boundaries pass.

### US-646: Round-trip positional tooling arguments between CLI and MCP

**Description:** As an agent or tooling author, a task's declared positional arguments keep their declared identity through serialization and parsing.

**Acceptance Criteria:**
- [ ] Argv serialization and argv parsing round-trip for every declared argument shape, including a declaration whose non-trailing optional positional is omitted; an omitted optional positional never lets a later positional occupy its slot on either the MCP or the CLI path.
- [ ] Where a declaration cannot express the caller's intent unambiguously, the surface fails with `ToolingInputError` naming the argument rather than binding a value to the wrong name; CLI and MCP emit the identical tag and message for the same input.
- [ ] If the chosen resolution rejects non-trailing optional positionals at normalization, the Landofile tooling surface change carries a compatibility acceptance and a guide update; if it fills or reorders instead, the canonical argv remains stable across repeated round trips.
- [ ] A failing regression test first captures the mis-bound positional through the MCP serializer and through the CLI parser; focused tests with a positive count, the flags-and-args and MCP guides, typecheck, lint, and boundaries pass.

### US-647: Rank routes safely across concurrently running apps

**Description:** As a user running more than one app, a specific hostname is served by the app that declared it, not by another app's wildcard.

**Acceptance Criteria:**
- [ ] For any two routes on concurrently applied apps that match the same request, an exact hostname is selected over a wildcard hostname and a longer path prefix over a shorter one, independently of how many routes each app declared.
- [ ] The outcome is determined by Lando's emitted priorities rather than by the router's rule-length tie-break; priorities for competing specificity classes are distinct, so an equal-priority wildcard can no longer outrank an exact host.
- [ ] Route rank derives from properties of the route itself — hostname specificity and path length — rather than from the route's index within its own plan, so plans ranked in isolation compose correctly in the merged router table; the diagnostic fallback keeps its reserved lowest priority and stays below every app route.
- [ ] Cross-app hostname ownership is not introduced: two apps may still claim overlapping hostnames, and no hostname registry, cross-app conflict refusal, or per-app priority banding is added.
- [ ] A failing regression test first writes two apps' dynamic configs into one watched directory and shows the wildcard winning; the route-shorthand guide is corrected from "within an app" to the actual policy; focused tests with a positive count, real-runtime evidence from two concurrently started apps with overlapping hostnames, typecheck, lint, and boundaries pass.

### US-648: Gate live provider tests on a socket that answers

**Description:** As a maintainer, live integration suites skip on a host with a stale provider socket instead of failing to connect.

**Acceptance Criteria:**
- [ ] The live provider socket gate proves the endpoint answers rather than that the path exists, so a socket file left behind by a dead daemon resolves to absent and the suites skip.
- [ ] Resolution stays synchronous and cheap enough for a module-level skip predicate, and no live suite is made slower on a host that has no socket at all.
- [ ] The explicit socket environment override keeps its precedence; an override naming a dead socket also resolves to absent rather than being exempted from the liveness check.
- [ ] A failing regression test first captures a socket path that exists but refuses connection; focused tests with a positive count, typecheck, lint, and boundaries pass. Maintainer-only test infrastructure: no public guide.

## Second residual wave (US-649..US-661)

These twelve follow the same rules as the stories above and are normative against [`spec-ir-residual-2.md`](./spec-ir-residual-2.md). Each was re-confirmed against current source before being queued; two recorded findings were retired instead (`spec-ir-residual-2.md` §10), and four findings were split or merged to stay inside this repository's measured pull-request size (§12). US-653, US-655, US-656, and US-661 are maintainer-only and record internal evidence instead of a public guide.

### US-649: Emit YAML from the command result envelope

**Description:** As a script or agent, a command that accepts `--format=yaml` emits the same result envelope it emits as JSON, not its human text.

**Acceptance Criteria:**
- [ ] `yaml` becomes a boundary-owned machine format derived from the same encoded envelope `json` produces, serialized through `@lando/sdk/yaml`; parsing the YAML yields the same model as parsing the JSON for a command with no bespoke format handling.
- [ ] Redaction, `--json` field projection, `--jq`, warning capture, and the broken-pipe exit policy apply to `yaml` identically to `json`, through the one existing seam rather than a parallel one.
- [ ] The hand-rolled YAML in `meta:config`, `meta:global:config`, `app:config`, and `app:config:translate` is reconciled against the boundary: envelope duplicates are deleted, and any survivor records in its spec why its document differs.
- [ ] `meta:doctor`'s report projection is decided explicitly — kept with a recorded reason or folded into the envelope — rather than left as an unexamined exception.
- [ ] A failing test first captures `lando info --format=yaml` emitting a tab-separated document; the scripting guide covers the format; applicable standard gates pass.

### US-658: Advertise a result format only where it is honored

**Description:** As a script or agent, every value a command offers in `--format` is a value that command actually produces.

**Acceptance Criteria:**
- [ ] `table` and `ndjson` leave `universalFormatFlagDefs` and are advertised per command, only by the commands that implement them; `text`, `json`, and `yaml` stay universal.
- [ ] A command asked for a format it does not implement fails with the existing `RendererSelectionError` naming the formats it does support, instead of emitting text at exit 0.
- [ ] `lando help`, compiled-mode argv parsing, and the generated command-registry manifest all reflect the per-command list, so an MCP client is never offered a format the command drops.
- [ ] Manifest regeneration lands in the same revision as the capability change, and `codegen:check` is clean afterward.
- [ ] A failing test first captures a command that implements neither format accepting both at exit 0; applicable standard gates pass.

### US-650: Run the Apache PHP launcher as the planned service user

**Description:** As an author, a `php:*` service served through Apache starts under a non-root `user:` without an authored `command:` workaround.

**Acceptance Criteria:**
- [ ] `php-via.ts` `apacheStartCommand` passes its configuration as repeated `-c` arguments and writes no site configuration, following the US-644 precedent, and serves the same document root and override behavior as before.
- [ ] The shared error-page writer in `http-errors.ts` is resolved once, for every current and future caller, rather than per launcher; whatever replaces the start-time write is the mechanism the nginx-family launchers consume in US-659.
- [ ] Anything else the daemon writes before PID 1 stabilizes is checked and resolved in the same pass, as Apache's `PidFile` was in US-644.
- [ ] A failing regression captures the mode failing to start under a non-root `user:` present in its image, through the planner, before the fix.
- [ ] `DEFAULT_COMMAND_AUDIT.md` moves this row out of `needs-fix`; the PHP guide stops implying the launcher requires root; real-runtime evidence shows a served response under a non-root user; applicable standard gates pass.

### US-659: Run the nginx-family and FPM launchers as the planned service user

**Description:** As an author, `nginx` with a backend, a `static` site, and a `php:*` FPM service all start under a non-root `user:`.

**Acceptance Criteria:**
- [ ] `nginx.ts` `phpFastcgiCommand`, `static.ts` `defaultStaticCommand`, and `php-via.ts` `fpmStartCommand` each write their generated configuration somewhere the planned user can write, and point the daemon at that path explicitly.
- [ ] No resolution places a writable file inside a root-owned tree, and none widens permissions on a path the image owns.
- [ ] All three consume the shared error-page resolution US-650 established rather than reintroducing a per-launcher write.
- [ ] `static:caddy` keeps its current write-free command byte-identically, and a service with no authored `user:` keeps its current generated output byte-identically.
- [ ] A failing regression per mode is captured first; `DEFAULT_COMMAND_AUDIT.md` moves all three rows out of `needs-fix`; the nginx, static, and PHP guides are corrected; real-runtime evidence shows a served response under a non-root user; applicable standard gates pass.

### US-660: Own the volume-backed data trees under the planned service user

**Description:** As an author, a Solr service with cores and a MinIO service either work under my non-root `user:` or tell me at plan time that they cannot.

**Acceptance Criteria:**
- [ ] `solr` with `cores:` and `minio` make the ownership of their volume-backed data trees correct for the planned user rather than assuming it, so `precreate-core`, the config overlay copy, and the bucket `mkdir` all succeed.
- [ ] A service whose data tree cannot be owned by its planned user refuses at plan time with a tagged error naming the service and the option, before any provider action, in the manner `HomePathCapabilityError` already refuses an unknowable home.
- [ ] The new error joins every plan-carrying union in one pass, is inserted once per union, and is recorded in `sdk/API_COMPATIBILITY.md` and the frozen service-tag fixture.
- [ ] The US-631 core-name rules and the US-618A config-overlay identity contract are unchanged; the empty-overlay identity tests still hold.
- [ ] A failing regression per mode is captured first; `DEFAULT_COMMAND_AUDIT.md` ends with no `needs-fix` row and keeps its reproduction section current; the Solr and MinIO guides document the refusal; real-runtime evidence covers both; applicable standard gates pass.

### US-651: Derive the Apache listen port from the planned service port

**Description:** As an author, setting `port:` on an Apache or PHP-via-Apache service moves the port the daemon actually listens on, not only its endpoint and healthcheck.

**Acceptance Criteria:**
- [ ] `apache` emits `Listen <port>` from the planned `port:` through the repeated-`-c` mechanism, and `php:*` via `apache` derives its `<VirtualHost *:<port>>` from the same value.
- [ ] The service ends up listening on the planned port and not additionally on the image's own `Listen 80`; the story proves which it produced and lands the resolution rather than adding a second socket.
- [ ] The existing `apache.test.ts` assertion that no `Listen` directive is emitted is replaced with a stronger one, not deleted: directives contain `Listen` at the planned port, and a service with no authored `port:` emits byte-identical output to today.
- [ ] `minio`'s fixed `9001` console port is recorded as a known limit in its guide; the Apache and PHP guides state plainly that a non-root service still cannot bind below 1024 and that `port:` is the author-side answer.
- [ ] A failing test first captures `port: 8080` producing no matching listen directive; real-runtime evidence answers a request on the planned port; applicable standard gates pass.

### US-652: Remove orphaned containers by observed identity

**Description:** As a user tearing down an app whose applied state is gone, the containers the provider still holds are actually removed, and the result names only what was removed.

**Acceptance Criteria:**
- [ ] Orphan container teardown removes observed containers through a provider-contract target that does not depend on the provider resolving its own applied plan; all three bundled adapters implement it in the same revision as the contract.
- [ ] A teardown result lists a service only when that service was stopped and removed; the current `selectionPlan` path, which reports `group.services` while iterating an empty `services` map, no longer reports unremoved containers.
- [ ] `provider.destroy` no longer returns a silent success when it resolved no plan and took no action; a planless destroy that finds no record yields an explicit no-op outcome.
- [ ] Orphan volume removal under `--volumes` distinguishes cache from data volumes the way planful bring-down already does through `pruneVolumeClasses`.
- [ ] The contract change is recorded in `sdk/API_COMPATIBILITY.md` and the frozen service-tag fixture; a failing test first captures an orphan group reporting a removed service while the container survives; real-runtime evidence shows the container present before and absent after; guides plus applicable standard gates pass.

### US-653: Collapse the volume ownership selector to one path

**Description:** As a maintainer, a volume's ownership identity is written one way and read the same way, with no pre-ship fallback.

**Acceptance Criteria:**
- [ ] The `plan.identity?.ownerKey ?? plan.root` fallback is removed from all four selector sites (`bring-up.ts`, `compose.ts`, and both in `bring-down.ts`); a plan without `identity.ownerKey` is migrated at read time or refused, never silently written in a second format.
- [ ] The relationship between `dev.lando.volume-selector` and `dev.lando.volume-owner` is stated in one place and enforced: one is derived from the other, or the story records why both exist and which is authoritative for which operation.
- [ ] Whatever remains carries a source comment naming the invariant, so it need not be reconstructed from a progress log.
- [ ] If the labels collapse, volumes created by an earlier build keep working through a recorded migration path.
- [ ] A failing test first captures a selector written without `identity.ownerKey` going unmatched by the reading side; focused tests with a positive count, typecheck, lint, and boundaries pass. Maintainer-only: no public guide.

### US-654: Revalidate the router observation on global lifecycle commands

**Description:** As a user following the doctor's advice, running the remediation it names clears the diagnostic it reported.

**Acceptance Criteria:**
- [ ] `meta:global:restart` and `meta:global:rebuild` re-observe the router's watcher startup and update or clear `watcher-diagnostic.json` on the same terms as `RouterService.setup`.
- [ ] A successful `lando global:restart` on a healthy watcher clears a previously written record, so the command named as the first remediation can actually affect the condition it remediates.
- [ ] A watcher that is still failing rewrites the record rather than clearing it, and the failure classification is unchanged from US-642.
- [ ] The doctor check keeps reporting the record as an unrevalidated observation; this story makes the record fresher and does not make doctor probe live.
- [ ] A failing test first captures `global:restart` leaving a stale record that doctor keeps reporting; guide plus applicable standard gates pass.

### US-655: Re-measure and record the unit-suite baseline

**Description:** As a maintainer, the current red unit tests are a measured list with named owners rather than an inherited count.

**Acceptance Criteria:**
- [ ] The baseline is re-measured on a clean checkout with `bun run test:unit` before anything is changed; the historical count of thirteen is treated as a lead, not a fact, and the measured result is recorded.
- [ ] Every failure that reproduces is recorded as its own queued item with its own reproduction; unrelated failures are never grouped under one cause.
- [ ] Failures that are self-contained are fixed in this story with a failing test captured first; anything larger is queued rather than absorbed.
- [ ] Each named candidate is resolved, queued, or explicitly recorded as not reproducing: `uninstall-runtime-service.test.ts`, `resolve.test.ts`, and `transcript-tail-reader.test.ts`.
- [ ] Focused tests with a positive count, typecheck, lint, and boundaries pass. Maintainer-only: no public guide.

### US-661: Fix the resolve-test isolation cascade

**Description:** As a maintainer, one slow test in `core/test/app/resolve.test.ts` fails alone instead of taking every later test in the file with it.

**Acceptance Criteria:**
- [ ] A test that exceeds its time budget no longer removes the temp directory out from under the tests that follow it; a single failure stays a single failure.
- [ ] The fix is an isolation defect fix in the harness, not a raised timeout; any timeout that is raised carries a per-test comment justifying that specific test.
- [ ] `withTempApp`, `withTwoTempApps`, and the five tests that chdir mid-test keep proving what they prove today, including cwd capture and cross-root isolation.
- [ ] The file's failure count is stable across repeated runs on the same tree, which is the observable the current cascade destroys.
- [ ] A failing test first captures the cascade; focused tests with a positive count, typecheck, lint, and boundaries pass. Maintainer-only: no public guide.

### US-656: Make pipeline gate outcomes legible

**Description:** As a maintainer, a pipeline step says what happened, so a failing gate is diagnosed once rather than every story.

**Acceptance Criteria:**
- [ ] The guide-scenarios job emits enough progress output to attribute a stall to a step, before any timeout value is changed; raising the hardcoded `timeout-minutes: 30` in `scripts/build-ci-workflow.ts` without that evidence is out of scope.
- [ ] The windows-arm64 stall point is identified from that output and the resolution lands where the stall is; if the cause is the runner rather than the repository, the finding is recorded with evidence and the job is quarantined explicitly rather than left to flake.
- [ ] Contributing documentation records that the looper Drift Audit step is workspace-local automation outside this repository, names its real owner, and distinguishes it from the in-repo `check:codegen-drift` and `check:guide-drift` gates and from `bun audit`, citing the evidence: no `.looper/` directory, no drift-audit package script, no `scripts/*audit*` file.
- [ ] That record distinguishes a skipped gate from a failed one, since conflating them is what let a gate fail for roughly a dozen stories unnoticed; no external automation is edited.
- [ ] The workflow change goes through the generator rather than the generated `ci.yml` and `codegen:check` stays clean; docs gates pass. Maintainer-only: no public guide.

## Maintainer checklist (not queued)

These items came out of the same audits but are not stories, carry no id or priority, and block none of the queued follow-ups. The unit-suite baseline and the looper Drift Audit gate were promoted out of this list into US-655 and US-656 in the second residual wave. Pick them up when a PR already touches the area, or when a current reproduction exists. None of them grants authority to push, merge, or mark work complete.

- **`RedisServiceConfig` schema consistency.** Publishing the Redis service config as an SDK schema is optional and belongs to whichever SDK PR already owns an additive export; follow `sdk/AGENTS.md`, record it in `sdk/API_COMPATIBILITY.md`, and rebuild `sdk/dist` before engine and core typecheck.
- **PR and merge evidence.** Before appending a reconciliation entry to the append-only progress log, check actual PR and commit state. A missing record means unrecorded, not unmerged.
- **Audit diagnostics.** Distinguish skipped from failed per gate; differing non-zero exits are never one shared cause. Find the real owner of each gate; external or workspace-local automation stays untouched and is recorded with an explicit owner and handoff instead of silent edits. The looper Drift Audit case is now queued as US-656; this remains the general rule for any other gate.
- **Plain HTTP through the router on fallback ports.** Several verify passes recorded a router 404 on the HTTP fallback port while HTTPS served the same app, and at least one was another server on the host answering instead of Lando. Host-port acquisition is owned by `../alpha/prd-alpha-08-proxy-host-ports.md`; hand any residual HTTP-entrypoint question there rather than opening it here, and confirm which server answered before calling it a Lando defect.
- **Ghost entries in `apps:list`.** A destroyed app once remained listed with empty services from leftover managed-runtime network state. This predates the teardown and inventory work at US-629 and was never re-reproduced afterward. Re-reproduce on current source before acting; a stale note is a lead, not a present defect. Re-confirmed as still unreproduced during the second residual wave (`spec-ir-residual-2.md` §10).
- **Scope of this list.** None of these require a failing product test to act on, and none are prerequisites for the stories above.
