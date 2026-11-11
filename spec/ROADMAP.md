# Lando v4 status and release bars

No public Lando v4 release has shipped. This file records what is built and what each release must prove before it is tagged.

**This file never decides what may be worked on.** A capability that is not built is in scope whenever a task asks for it: build it to its spec section, and author any missing design in that section first. Release stages gate tags, not merges. Only §14.1 and the part-level non-goal sections put work out of scope.

**Feature freeze: not in effect.** A freeze exists only when a maintainer replaces this line with a dated declaration.

## Release ladder

| Stage | Version / channel | Artifacts |
| --- | --- | --- |
| Alpha (current) | `4.0.0-dev.N` on `dev` | Unsigned GitHub prereleases |
| Beta | `4.0.0-beta.N` on `next` | First Beta tag |
| RC | `4.0.0-rc.N` on `next` | First production-signed distribution |
| 4.0 GA | `4.0.0` on `stable` | Promoted from the last green RC |
| 4.x | Later minors | Release vehicles only; no work is reserved for them |

Earlier private phases (MVP and the internal Alphas and Betas) are pre-alpha history, not a forward plan.

## Release bars

### Alpha (`4.0.0-dev.N`)

Exit when:

1. Live `lando setup` and `lando doctor` pass on all six targets: `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64`, and `windows-arm64`.
2. Drupal and Rails journeys pass on all six targets: start the app, run recipe tooling, and run `lando info`.
3. On `darwin-x64`, the supported path is Docker Desktop through `provider-docker`; `provider-lando` stays fail-closed there.
4. Public artifacts are unsigned `4.0.0-dev.N` builds on `dev`.

Status (2026-11-05): main CI publishes unsigned six-target GitHub prereleases (latest `v4.0.0-dev.1445`); no `4.0.0-dev.N` npm package has been published. The `platform-readiness`, `drupal-journey`, and `rails-journey` workflows cover all six targets, but none has passed on `main` yet: the latest completed runs failed on the Linux cells and cancelled the self-hosted macOS and Windows cells. Criteria 3 and 4 hold.

### Beta (`4.0.0-beta.N`)

Exit when known Alpha blockers are fixed and the candidate is ready for RC.

### RC (`4.0.0-rc.N`)

RC is the first stage that requires production signing, notarization, SBOM, SLSA provenance, curl-pipe installers, and self-update on the release matrix (§17.9). Alpha and Beta do not.

Exit when every §17.9 binary-shipping item is green on the release platforms and two RC iterations have zero blocker bugs.

Status (2026-11-05): signing, notarization, SBOM, provenance, and cosign stages exist in the manual signed-release orchestrator and are credential-gated; CI wires none of them. Installer scripts and `lando update` exist. The live install surface is GitHub Release artifacts, as unsigned dev prereleases only; the `get.lando.dev` installers and `update.lando.dev` channel manifests are not live.

### 4.0 GA

Tag `4.0.0` from the last green RC onto `stable`. The GA tag adds only version bumps and RC bug fixes.

## Capability status

Audited against `main` on 2026-11-05. **Built** means reachable from the CLI or library. **Partial** means some runtime exists, and the note names what is missing. **Contract only** means SDK schemas, service tags, or a `NotImplementedError` stub exist without a runtime. **Not started** means nothing exists beyond the spec. Update a row in the change that moves it.

Built and not listed below: the Effect runtime and SDK contracts; the service-type catalog, recipes, and tooling, including `command:` steps; global and scratch apps; the `lando`, Docker, and Podman providers; Mutagen file sync, proxy, CA, setup, doctor, and uninstall; schemas, telemetry, machine output, and MCP over stdio; `lando open`, `lando run`, and the Landofile version constraint; host SSH-agent and gpg-agent forwarding; the `env` and `1password` secret stores; and the `@lando/core/testing` export (not yet published to npm).

### Remote sync, hosters, and sharing

| Capability | Spec | Status | Notes |
| --- | --- | --- | --- |
| `RemoteSource`/`Dataset` orchestration for pull, push, and remotes | §10.12 | Partial | Engine operations, CLI commands, and library handles are wired and fail closed without plugins. No bundled `RemoteSource` or `Dataset`; no `switch`. |
| `CodeSync` | §10.12.1 | Not started | Contract-suite doubles reject code-tree bindings. |
| Remote protection | §10.12.8 | Partial | Environment-level `protected`/`protectedByDefault` and push `--force` exist; target-bound approval does not. |
| Tethered sessions | §10.12.5 | Not started | Only an MCP never-allow entry for `app:remote:tether`. |
| Vendor tools | §10.12.4 | Contract only | `RemoteToolMissingError` and `capabilities.tool`; the engine never runs a vendor tool. |
| Bundled `dotenv` config `Dataset` | §10.12.7 | Not started | `dotenv` appears only as an unsupported tooling key. |
| `lando` and `lando-session` secret stores, durable grants | §9.5.1 | Not started | |
| SSH identities for remotes | §10.4 | Not started | Host agent forwarding is built. |
| Hoster init sources | §8.8.13 | Not started | Git, tarball, npm, and registry recipe init are built. |
| Local-snapshot translation and `remote-metadata` cache | §7.4.2, §12.1 | Not started | The `ConfigTranslator` framework is built. |
| Pantheon, Acquia, and Upsun connectors; hoster recipes | §10.12, §8.8 | Not started | |
| `TunnelService` and `lando share` | §10.2.2 | Partial | Share, list, stop, and the tunnel registry are wired; no bundled `TunnelService`. |

### Renderer and CLI

| Capability | Spec | Status | Notes |
| --- | --- | --- | --- |
| Rich render events (`code.snippet`, `diff.render`, `markdown.block`) | §8.9.4 | Partial | Schemas plus plain and JSON fallbacks; no rich TTY presentation or core emitters. |
| Renderer panel slots | §8.9.5 | Contract only | Schemas, manifest validation, and the contract suite; no runtime or bundled panel. |
| Keymap overrides and help overlay | §8.9.6 | Partial | Action vocabulary and `KeymapConfig` schema exist; the renderer uses fixed task-tree keys, with no global `keymap:` wiring and no overlay. |
| Interactive `app:logs --follow` viewer | §8.9.8 | Not started | Line-mode follow works; `--no-viewer` is a no-op. |
| `meta:events:follow` | §8.2 | Contract only | Registered deferred command returning `NotImplementedError`. |
| Task-tree `--tail`, `--expand`, and `--collapse` flags | §8.9 | Not started | Flags fail with remediation; Enter/Esc expand and collapse keybindings are built. |
| MCP streamable HTTP transport | §10.14 | Not started | Stdio only; needs a §10.14 transport contract first. |
| `registry:<id>` includes | §7.7.1 | Not started | Local, `user:`, git, and `npm:` includes are built. |
| `meta:plugin:add` from Git, `file:`, or tarball | §9.6 | Not started | npm sources are built. |
| Live MCP tooling catalog replacement | §8.5.1, §10.14 | Not started | Tooling descriptors are captured at session start; clients reconnect after tooling declarations change. Mid-session plugin tool additions and same-id variants are built (§10.14); atomic whole-catalog replacement and tool removal remain open. |

### Runtime, checks, and build

| Capability | Spec | Status | Notes |
| --- | --- | --- | --- |
| App checks: ownership-classified verdicts | §10.5.2 | Partial | `ready`, `app-error`, `service-error`, and `lando-error` with the router marker exist; the neutral `expected` state does not. |
| App checks: Landofile `checks` replacing `scanner` | §10.5.2 | Not started | Depends on the verdict row. |
| App checks: `command` and `tcp` kinds plus `app:check` | §10.5.2 | Not started | Checks are HTTP only. Depends on the `checks` row. |
| Programmable execution | §22 | Not started | The §22 contracts are on `main`, so nothing blocks implementation. Build in dependency order: contracts and retained runtime; configuration-backed scratch and admission; environment, process, and artifact integration; public access, guides, and performance proof. Each slice includes its tests. |
| Readiness scheduler extraction | §5.3, §10.5.1 | Not started | Providers still run readiness attempts inline. |
| Durable readiness last-proof storage | §6.10 | Not started | Needs an identity and invalidation design first. |
| Full Bun config-source isolation for child processes | §9.6 | Not started | Network and CA projection are built. |
| Error, event, service, recipe-action, API-report, acceptance-index, Mutagen-client, and plugin-template generators | §17.2 | Not started | |
| Multi-provider apps | §5.9 | Not started | One provider per app. |
| §14.2 extension constraints: OS-keychain store, persistent agent, explicit `global:` dependencies, service-type `topLevelAlias` | §14.2 | Not started | Each has its trigger condition in §14.2. |
| Install surfaces beyond GitHub Releases and `get.lando.dev` | §17.7 | Not started | Outside the current install contract; adding one extends §17.7 and §17.8. |

Smaller deferred items are noted inline in their spec sections and in GitHub issues. The same rule applies to them: deferred means not built, not out of scope.
