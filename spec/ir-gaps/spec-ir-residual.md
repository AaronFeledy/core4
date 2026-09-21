# Spec: IR residual defects

Status: authored design, pre-implementation. Normative for priorities 57..62 in this directory. The twenty-four stories at priorities 21..56 are shipped; this document covers only the defects their QA and review passes recorded without queueing.

## 1. Goal

Every finding below was observed against a compiled binary during the verification of an earlier story, ruled out of that story's scope, and written to `progress.txt` without an owner. Each one was re-confirmed against current source before being specified here; none is carried forward on the strength of the log alone.

The findings share a shape: a surface that is correct for its primary caller fails for a second caller that arrives through a different path. Teardown reuses the start planner. Apache reuses the start command for a non-root user. Machine output reuses a renderer built for a terminal. MCP reuses an argv serializer built for dense positionals. The proxy reuses a per-app ranker in a global router table. The specification for each is therefore a statement about which caller the surface must now also serve, not a request for a new feature.

## 2. Decisions (recorded)

These decisions are closed and bind the stories:

1. **Teardown answers to observed state, not to desired config.** `lando stop` and `lando destroy` exist to remove what is present. A Landofile that cannot be validated or planned MUST NOT block the removal of resources whose existence was never derived from it, and MUST NOT block the report that there is nothing to remove.
2. **Owned orphans are a teardown target, not a mismatch.** Runtime resources whose recorded owner is the app root under teardown are exactly what teardown removes. Fail-closed orphan refusal stays correct for every non-teardown caller.
3. **A planned service user applies to the whole start command.** A service type MUST NOT emit a default command that only succeeds as `root` while its own catalog accepts a non-root `user:`.
4. **Machine output is a contract with a program.** `--format=json`, `--format=yaml`, and `--jq` are consumed by scripts, agents, and MCP clients. Truncation by a closed pipe is a normal end of consumption, and emitted YAML MUST parse back to the model that produced it.
5. **One YAML emitter.** The quoting rules US-633 established for Compose export are the repository's YAML scalar policy. A second hand-rolled emitter is a defect regardless of whether its current inputs happen to be safe.
6. **A declared positional keeps its position.** Argv serialization and argv parsing are one round trip. An omitted optional positional MUST NOT let a later positional occupy its slot.
7. **Route rank is global because the router table is global.** Traefik merges every app's dynamic file into one router set. Ranking that is correct only within one `AppPlan` is not correct at the seam where it is consumed.
8. **A test gate proves liveness, not presence.** An integration gate that keys on a path existing will run against a dead endpoint and report a connection failure as a test failure.

## 3. Non-goals

- Host port acquisition and the `80`/`443` fallback. Owned by [`../alpha/prd-alpha-08-proxy-host-ports.md`](../alpha/prd-alpha-08-proxy-host-ports.md) (US-601..US-606). The repeated fallback notices in `progress.txt` are that PRD's subject, not a defect here.
- Any change to `lando start`'s fail-closed posture. Start MUST keep refusing an unplannable app.
- Cross-app hostname reservation, a global route registry, or any change to which app may claim a hostname. §7 bounds the proxy story to rank safety.
- Repairing the looper Drift Audit gate or any other external automation. Recorded in the maintainer checklist with an owner handoff, per the existing convention in `prd-ir-gaps-01-stories.md`.
- Widening `AppResolveError`, `ServiceStartError`, or any other public error shape. Every story here changes when an error is raised, not what the error is.

## 4. Teardown and desired config

### 4.1 Present behavior

`destroyApp` resolves its target through `resolveDesiredTarget` first, which loads the Landofile and runs the planner. Applied state is consulted only as a fallback after that fails, and when no applied plan exists the original desired error is re-raised:

- `engine/src/operations/destroy.ts` — `resolveDesiredTarget` then `resolveDestroyTarget`
- `engine/src/operations/stop.ts` — the same pattern

The idempotent `outcome: "unchanged"` result is produced in exactly one place, and only after a **successful** desired plan:

- `engine/src/operations/destroy.ts` — the `requireAppliedEvidence` branch

Consequences observed on the binary:

| Situation | Observed | Required |
|---|---|---|
| Never started, Landofile fails validation | `LandofileValidationError` | `unchanged` |
| Never started, Landofile refuses `HomePathCapabilityError` at plan | `HomePathCapabilityError` | `unchanged` |
| `destroy` then `destroy --volumes` | `AppResolveError` `provider-resources` | volumes removed |

The second row is currently locked in by `engine/test/operations/applied-state-teardown.test.ts`, which asserts that the desired-config failure is preserved when no applied plan exists. That assertion is the contract this section changes; the story MUST flip it deliberately rather than delete it.

### 4.2 Required behavior

Teardown MUST resolve the app **root** from discovery, which succeeds on an invalid Landofile, and MUST consult applied state and runtime evidence against that root before it plans the desired config.

1. No applied plan and no owned runtime resources → `outcome: "unchanged"`, no provider action, exit 0, whatever the Landofile says.
2. An applied plan exists → tear down from the applied plan, as today.
3. No applied plan but owned runtime resources exist → tear them down as orphans of this root. The desired plan is loaded only if teardown needs it, and a desired-config failure at that point is reported as it is today.
4. `lando start` and every non-teardown caller keep the current fail-closed orphan refusal at `engine/src/providers/applied-state-resolution.ts`; the relaxation is scoped to teardown callers and MUST NOT be implemented by widening the shared evidence resolver's default.

Volume retention keeps its present rule — a plain `destroy` leaves data stores and clears applied state — so rule 3 is the path that makes a follow-up `destroy --volumes` succeed.

### 4.3 Diagnostics

`unchanged` MUST stay distinguishable from `destroyed` in every renderer and in `--format=json`. An orphan teardown MUST report what it removed rather than silently succeeding, because the user's mental model at that point is that the app is already gone.

## 5. Service user and the default start command

### 5.1 Present behavior

`plugins/service-lando/src/services/apache.ts` installs a default `command` when the author declared neither `command` nor `entrypoint`. That command is a shell that writes `/usr/local/apache2/conf/extra/lando-webroot.conf` and then execs `httpd-foreground` against it. The same feature applies `setUser(service.user)`, which reaches the container create body as `User`, so the write runs as the service user.

With `user: www-data`, the write is refused by the image's root-owned config tree, PID 1 exits, and the service applies as `stopped`. A later rebuild raises `ServiceExecError` against the stopped container, and a recreate can raise `ServiceStartError`. An authored `command:` override bypasses the write and runs, which is what isolates the default command as the cause.

The catalog already declares a `www-data` identity for Apache with home `/home/www-data`, verified against the shipped image in US-637, so the service type advertises support for exactly the user that fails.

### 5.2 Required behavior

A service type that accepts a non-root `user:` MUST NOT ship a default command that requires root. Apache MUST start and stay running with `user: www-data` and no authored `command`.

The mechanism is left to implementation, but it MUST NOT be a documentation change, MUST NOT require the author to supply a `command:`, and MUST NOT drop the webroot configuration. Materializing the config before the process drops privileges, writing it in a root build step, or placing it where the planned user can write it are all acceptable.

Proof is the running state, not the absence of a tag: the service must be running and serving the configured `DocumentRoot`. `ServiceExecError` and `ServiceStartError` are downstream symptoms whose appearance depends on which operation runs next, so an acceptance test that asserts either tag is testing the wrong thing.

### 5.3 Scope

Apache is the only catalog entry with a confirmed reproduction. The story MUST check whether any other bundled service type emits a default command that writes outside the planned user's reach, and either fix or record each one. It MUST NOT redesign the service-type command surface.

## 6. Machine output

### 6.1 Closed pipe

`renderer/src/io.ts` builds the stdio `RendererIO` with a bare `stdout.write(chunk)` and no error handling. A consumer that exits early — `head`, `jq -e`, a killed agent process — closes the pipe, and the resulting `EPIPE` propagates as an unhandled stream error. `lando info --format=json | head` crashes.

Required: a closed downstream pipe MUST end output cleanly. Lando MUST NOT report an internal error, MUST NOT print a stack trace, and MUST use the conventional shell exit status for a terminated pipeline. Diagnostics written to stderr follow the same rule independently, since stdout and stderr can be redirected separately.

### 6.2 YAML quoting

`core/src/cli/commands/config.ts` defines a private `formatYaml` that emits every scalar unquoted. Any string that YAML would reinterpret is corrupted on the way out:

| Emitted value | Parses back as |
|---|---|
| `[redacted]` | empty sequence |
| `yes`, `no`, `on`, `off` | boolean |
| `1.0`, `0x10` | number |
| `null`, `~` | null |
| a value containing `: ` | mapping |
| a value with a leading `*`, `&`, `%`, `@` | alias, anchor, directive, reserved |

The redaction sentinel is the observed case: `lando config --format=yaml` emits `DB_PASSWORD: [redacted]`, which reads as a sequence. No secret leaks, but a script that round-trips the document gets a different model than Lando held.

US-633 already established the quoting policy for Compose export in `container-runtime/src/podman/compose.ts`, where `scalar` and `mappingKey` decide quoting against what YAML can re-resolve. Those helpers are private to that module.

Required: one YAML scalar and key policy, shared. The CLI config emitter MUST consume it rather than re-implement it. Every `--format=yaml` surface MUST satisfy a round-trip law — parsing emitted YAML yields a document structurally equal to the source model — proven over the shapes in the table above, not only over the redaction sentinel.

The policy lives in a package both callers may import under the package DAG. Publishing it on a public SDK subpath is optional and, if chosen, follows `sdk/AGENTS.md`.

## 7. Positional tooling arguments

`landofile/src/tooling-input.ts` holds both halves of the round trip. `serializeToolingInput` emits declared positionals with `flatMap`, skipping any whose value is absent; `parseToolingArgv` assigns received positionals by declaration index. The two disagree whenever a non-trailing positional is optional and omitted:

- Declared `args: [a (optional), b]`, value supplied only for `b`
- Serialized as `["--", "<b>"]`
- Parsed back as `a = "<b>"`, `b` unset

The MCP tool projection serializes structured input to argv through this path, so an agent calling a task with a hole in its positionals silently binds the wrong argument. The CLI reaches the same parser, so `lando <task> <value>` binds to the first declared positional whether or not the author meant it to.

This is the `toolingArgv` positional-order item deferred from US-613 and again from US-614.

Required: serialization and parsing round-trip for every declared shape, including holes. A task whose declaration cannot express the caller's intent without ambiguity MUST fail with `ToolingInputError` naming the argument, rather than binding a value to the wrong name. Whether holes are filled with a placeholder, rejected at normalization, or made expressible is an implementation choice; the round-trip law and the CLI/MCP parity law are the contract.

## 8. Route rank across apps

### 8.1 Present behavior

`prioritizeRoutes` in `engine/src/planner/route-identity.ts` sorts one plan's routes — exact host before wildcard, then longest path, then lexical ties — and assigns `routes.length + 1 - rank`. A plan with three routes gets `4, 3, 2`; a plan with one route gets `2`. Route identity and conflict detection key on scheme, hostname, and path with no app component.

`plugins/proxy-traefik/src/proxy.ts` writes one `routes-<appId>.yml` per app into a single directory that Traefik's file provider watches. Router and service **names** are namespaced by app id; **priorities are not**. Traefik merges every file into one router table and selects the highest priority among matching routers.

Two independent apps therefore compete in one priority space allocated per app:

- App A declares three wildcard routes and receives priorities `4, 3, 2`.
- App B declares one exact host and receives priority `2`.
- A request matching both is served by A's priority-`4` wildcard.

The equal-priority case is also unsafe: at priority `2` on both sides, Traefik's own tie-break prefers the longer rule, and the generated `HostRegexp(...)` for a wildcard is longer than the `Host(...)` for an exact host. A single-route wildcard app can take a single-route exact-host app's traffic without ever winning on priority.

Both apps share the default domain, so the overlap needs no custom domain to occur. `docs/guides/proxy/route-shorthand.mdx` documents the ordering as holding "within an app", which matches the code and is why the review deferred it.

### 8.2 Required behavior

For any two routes on concurrently applied apps that match the same request, an exact hostname MUST be selected over a wildcard hostname, and a longer path prefix MUST be selected over a shorter one, independently of how many routes each app declared. The rule may not depend on Traefik's rule-length tie-break; priorities must be distinct enough that the outcome is determined by Lando's policy.

The rank must be derived from properties of the route itself — hostname specificity and path length — rather than from the route's index within its own plan, so that two plans ranked in isolation still compose correctly in the merged table. The diagnostic fallback keeps priority `1` and MUST stay below every app route.

### 8.3 Bounds

This section does not introduce cross-app hostname ownership. Two apps may still claim overlapping hostnames; the requirement is only that the more specific claim wins deterministically. Cross-app conflict refusal, a hostname registry, and per-app priority banding are out of scope. The guide's "within an app" wording is updated to state the actual policy.

## 9. Live provider socket gate

`engine/src/testing/live-provider-socket.ts` resolves a socket by `statSync(path).isSocket()`. A socket file left behind by a dead daemon satisfies that predicate, so `hasLiveProviderSocket()` reports true and every `test.skipIf` gate that depends on it opens. The integration suites then fail on connection rather than skipping. A stale `runtime/run/podman.sock` on a developer host reproduces this for every live suite at once.

Required: the gate proves the endpoint answers, not that the path exists. Resolution stays synchronous and cheap enough for a module-level `skipIf`, and a dead or unreachable socket resolves to absent so the suites skip. The `LANDO_TEST_PODMAN_SOCKET` override keeps its precedence; an override naming a dead socket also resolves to absent, since the alternative is the failure being specified away.

## 10. Testing

Each story reproduces on current source before fixing. Every story lands a failing test first:

| Section | Failing test first |
|---|---|
| §4 | Destroy on a never-started app whose Landofile fails validation; destroy with volumes after a plain destroy |
| §5 | Apache planned with `user: www-data` and no authored command |
| §6 | Piped machine output with an early-exiting consumer; YAML round trip over the §6.2 table |
| §7 | Serialize-then-parse over a declaration with an omitted non-trailing optional positional |
| §8 | Two apps' dynamic configs in one directory, asserting selection order |
| §9 | A socket path that exists but refuses connection |

§4, §5, and §8 change user-visible behavior on a real runtime and carry real-provider evidence at Verify. §5's evidence is the running service and a served response, not a tag. §8's evidence is two concurrently started apps with overlapping hostnames.

§9 is maintainer-only test infrastructure with no public guide.

## 11. Open items

- Whether the §6.2 YAML policy is published on a public SDK subpath or stays private to a workspace package is left to the implementing story, decided against `sdk/AGENTS.md` and the package DAG.
- §7 may conclude that a non-trailing optional positional is not expressible and must be rejected at normalization. That is an acceptable resolution and changes the Landofile tooling surface; if chosen, it needs a compatibility acceptance and a guide update.
- §8 leaves the exact priority function open. A fixed band per specificity class and a monotone function of path length both satisfy the requirement; the choice affects how many distinct priorities Traefik sees.
