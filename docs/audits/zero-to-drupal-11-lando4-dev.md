# Zero to Drupal 11 on `lando4-dev`

Started: 2026-07-20T18:41:07-05:00
Repository HEAD: `e1ecd3396765fe22741707a911017dd156767733`
Build-host Bun: `1.3.14`

## Goal

Exercise Lando as a first-time Ubuntu user, without manually installing or substituting any prerequisite, until a Drupal 11 site is installed against a Lando-managed database and works in a real browser. Record every functional and usability gap, repair confirmed product defects with regression coverage, and repeat the journey from a clean snapshot.

## Constraints

- The tested CLI is the freshly compiled `core/dist/lando` binary.
- Sandbox setup must begin with `lando`, `bun`, `podman`, `docker`, and `brew` absent.
- Lando itself must acquire and configure everything required to run the environment.
- No host runtime, test socket, manual package installation, or hand-written replacement Landofile may bypass the user flow.
- Interactive prompts are exercised in the persistent `lando4-dev` tmux session.
- Drupal, Composer, Drush, PHP, and database operations run through Lando.

## Journey Journal

| Round | Phase | Expectation | Observed result | Usability finding | Defect | Retest |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Baseline | Fresh Ubuntu sandbox satisfies `.local/DEV-ENV.md` and has no Lando dependencies. | Passed: Ubuntu 26.04 LTS, user `aaron`, sudo/systemd/tmux/shared mount ready, dependencies absent. | None yet. | - | Pending |
| 1 | Fresh binary | Current source compiles to an executable Linux binary. | Passed: Linux x86-64 ELF, 197,154,944 bytes, SHA-256 `5d14e51ef17086aa7152b2816625d1e917123acdd8e6c8f7f53b696175bb95f5`. | Build emitted no progress text, but completed quickly and cleanly. | - | Pending |
| 1 | First-run setup | Interactive `lando setup` installs and activates all prerequisites. | Blocked after 12.3s: runtime bundle verification passed, then `Detect Podman` failed in 4ms and instructed the fresh user to install Podman >= 6.0.0. No provider-selection prompt appeared. | The progress tree clearly identified the failed step, but the remediation contradicts the managed-runtime promise and gives the user no Lando-owned path forward. | `D11-001` | Pending |
| 1 | First-run setup retest | Consent, prerequisite provisioning, runtime launch, and CLI exit all complete from the clean snapshot. | Passed with binary SHA-256 `35c18a193b6ca0d69342e79e020fad03d10cff71d4024f0d71f740e6c7d2c631` and local immutable bundle 0.1.5: the uidmap prompt appeared before progress, accepted `y`, setup rendered ready, and exited 0 naturally. | Setup is now coherent and agent-drivable; publication of bundle 0.1.5 remains required for a zero-override production proof. | `D11-001`-`D11-004` | Passed locally |
| 1 | Drupal init | Bundled Drupal recipe scaffolds a clear, usable Drupal 11 project at the spec-defined destination. | Initial invocation used an undocumented `--destination` flag and exposed an adapter gap. Per spec §8.8.1, `lando apps init [<destination>]` now accepts an optional positional destination, then falls back to `--name`, then cwd; piped stdin is ignored. | The repaired source and compiled commands are automation-safe and reject `--destination` as an unknown flag instead of silently accepting the wrong contract. | `D11-005` | Passed: 24/24 focused/parity tests plus manual positional init |
| 1 | Global image materialization | App auto-start and `lando global:start` build/pull global service artifacts before provider apply. | Initial start failed because Mailpit had not been pulled. The repaired path builds the selected global plan before apply; real `lando global:start --service mailpit` succeeded twice with the verified package binary. | The original nested error remains useful historical evidence, but a fresh image store no longer blocks the selected service. | `D11-006` | Passed twice |
| 1 | Rootless DNS without linger | Managed rootless Podman starts Netavark/Aardvark and resolves service aliases without a user systemd bus. | Initial container start failed because Netavark selected `systemd-run --user` while `Linger=no` and `/run/user/1000/bus` was absent. Runtime-bin-only `PATH` on the managed daemon selected Netavark's direct Aardvark launcher; repeated Mailpit starts and DNS probes passed without changing policy. | Correctness no longer depends on an undocumented host persistence change. Optional linger is a separate, explicit convenience only. | `D11-007` | Passed independently with `Linger=no` |
| 1 | Rootless global ingress | Traefik publishes HTTP and HTTPS routes without privileged host changes. | Blocked in current product: host port 80 cannot bind while `net.ipv4.ip_unprivileged_port_start=1024`. Direct managed-Podman proof succeeded twice with `127.0.0.1:38080:80` and `127.0.0.1:38443:443`, including a disposable Drupal 11 installer through both routes. | Rootless-safe published ports and their authority must propagate through planning, provider execution, `open`, `info`, redirects, and forwarded scheme handling. Bare 80/443 requires a prohibited privileged owner. | `D11-008` | Blocker confirmed; high-port mechanism proven, product repair pending |
| 1 | Verification | CLI, database query, routes, browser render, and login all work. | Pending. | Pending. | Pending | Pending |
| 2 | Clean repeat | The repaired complete journey succeeds from the golden snapshot. | Pending. | Pending. | Pending | Pending |

## Evidence Index

Raw evidence is collected under `.local/audit-artifacts/zero-to-drupal-11/` and is intentionally ignored by Git. Any secret-bearing material will be removed rather than published here.

Latest independently verified package-built binary: `core/dist/lando`, SHA-256 `65c0bdaf3fc5a733a12b016263e8b6b5431a4e365046009cbe8c4ad1402a730a`.

Concurrent builds later changed `core/dist/lando` during the rootless-port spike: its Lando control observed `8b27022da0663a70e067c7a2b54ff3c266d71313f62e21285ecdb24ae82992e3`, and cleanup observed `02695fb3dbf81b1dd87f4cc87ee2dfb6f0bfd186af0492c4a1d218655bab941d`. The spike did not build or edit product code; its direct managed-Podman low-port control and high-port proof do not depend on those binaries.

## Findings and Repairs

### `D11-001`: first-run setup requires a preinstalled Podman

- Expected: interactive setup selects or defaults to the Lando-managed provider, installs its verified runtime bundle, and leaves a ready provider on a dependency-free Ubuntu host.
- Actual: bundle verification succeeds, then setup probes `podman` on `PATH` and blocks with `Install Podman >= 6.0.0 and rerun lando setup`.
- Impact: critical first-run blocker; Drupal init/start cannot proceed without sidestepping Lando.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/round-01/tty.log`.
- Root cause: runtime bundle 0.1.4's Linux Podman links to `libgpgme.so.11`, which is absent on the clean image; the bundle portability gate allowed that host dependency. The bundled command runner also mislabeled dynamic-loader failures as missing system Podman.
- Repair: the next immutable source bundle version is 0.1.5; Podman now builds with `containers_image_openpgp`, GPGME-family libraries are forbidden by portability verification, obsolete build prerequisites are removed, and bundled launch failures receive managed-runtime remediation.
- Regression evidence: focused runtime build/verification/supply-chain/workflow suite passed 48 tests; focused provider setup suites passed with the new bundled-loader diagnostic.
- Retest status: passed with the local checksum-verified 0.1.5 bundle; subsequent published zero-override proof remains pending. The immutable 0.1.4 production manifest has not been overwritten.

### `D11-002`: setup does not provision Ubuntu rootless prerequisites

- Expected: the explicit first-run setup command performs the host preparation required by the Lando-managed runtime, with consent and privilege boundaries.
- Actual: after corrected Podman detection, the detached service exits because `newuidmap`/`newgidmap` are absent. Setup waits about 44 seconds before failing; current remediation requires a manual package-manager command.
- Environment evidence: subordinate UID/GID ranges exist, cgroups v2 is active, and `XDG_RUNTIME_DIR` is valid. Only the Ubuntu `uidmap` tools are absent.
- Impact: critical first-run blocker on the documented dependency-free reference host.
- Repair: setup performs consented Ubuntu 26.04 `uidmap` provisioning through `PrivilegeService` before acquiring the task-tree terminal substrate, then re-probes inside the managed runtime setup phase.
- Retest: passed from the golden snapshot; `/usr/bin/newuidmap` was installed only after consent and the runtime socket became ready.

### `D11-003`: runtime launch/readiness failure is invisible in the setup task tree

- Expected: setup progress identifies prerequisite provisioning and managed runtime launch, and the failed step shows the tagged message/remediation.
- Actual: the tree shows bundle and Podman detection as online, leaves `state` waiting, then ends at `2 ONLINE · 1 BLOCKED` with no root cause. A `--format json` invocation in the TTY also rendered the task tree and produced no visible JSON error envelope.
- Impact: users wait through the full readiness budget and cannot diagnose the failure from command output.
- Repair: prerequisite, launch, readiness, and state phases are explicit in the runtime setup tree and carry tagged failure detail.
- Retest: passed on the corrected path; all six runtime steps completed visibly.

### `D11-004`: interactive host-change prompt crashes the compiled TUI

- Expected: the user sees a clear yes/no confirmation, answers once, and setup resumes the task tree.
- Actual: the consent text appears without a visible choice affordance above the active task tree; `y` plus Enter does not resolve it, and a subsequent Enter throws `Failed to create optimized buffer: 80x2` from OpenTUI.
- Impact: the default interactive setup path crashes before the consented host change, so only automation flags could continue.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/round-01c/tty.log`.
- Root cause: setup requested consent from its line-based `InteractionService` after the task-tree substrate had already acquired the terminal. Moving consent before tree acquisition removed the crash, but exposed a second defect: `createLineReader` retained Bun's stdin async-iterator handle after a successful read, so setup rendered success but remained in `epoll_wait`.
- Repair: host prerequisite consent now completes before task-tree acquisition; `createLineReader` uses scoped data/end/error/abort listeners, removes them, and pauses stdin between reads without losing buffered-ahead input.
- Regression evidence: focused prompt and interaction suites passed 150 tests; a real Bun child now exits naturally after its parent writes `y` while keeping stdin open.
- Retest: passed from the golden snapshot; `.local/audit-artifacts/zero-to-drupal-11/round-01g/tty.log` records `FINAL_INTERACTIVE_SETUP_EXIT=0` without `Ctrl+C`.

### `D11-005`: positional init destination was not threaded through OCLIF

- Expected: per spec §8.8.1, `lando apps init [<destination>]` accepts an optional positional destination and otherwise uses `--name`, then the current directory.
- Actual: the initial audit used an undocumented `--destination` form that was dropped by the adapter; the first attempted repair would also have preserved that incorrect surface.
- Impact: explicit destinations and automation could resolve to an unintended directory, while piped stdin could be consumed as the omitted positional argument.
- Repair: `apps:init` declares optional positional `destination` with `ignoreStdin: true`, removes the undocumented destination flag, and resolves `positional ?? name ?? "."` against the invocation cwd. `--destination` now exits 2 as an unknown flag.
- Verification: adapter, downstream, generated-manifest, dispatch, and behavioral parity passed 24/24. Source and compiled manual invocations created their requested positional destinations with equivalent generated Landofiles.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/wave-02-verification/{report.md,init-compiled-positional.txt,init-source-positional-success.txt,init-generated-landofile.diff}`.
- Status: verified repaired.

### `D11-006`: global start applied image-only services before building/pulling artifacts

- Expected: app auto-start and `lando global:start` materialize required global service images before container creation.
- Actual: app start wrapped the failure as `GlobalAutoStartError`; manual global start exposed Podman HTTP 404 for absent `docker.io/axllent/mailpit:v1.30.1`.
- Impact: every fresh app requiring bundled global services was blocked despite a healthy provider.
- Root cause: normal app start called `BuildOrchestrator.build(plan)` before provider apply, while `globalStart` applied its selected plan directly even though provider-lando's build orchestrator owns image pulls through `pullArtifact`.
- Repair: the global start path builds the selected plan before provider apply.
- Verification: the package-built binary with SHA-256 `65c0bdaf3fc5a733a12b016263e8b6b5431a4e365046009cbe8c4ad1402a730a` ran `lando global:start --service mailpit` successfully twice; service-alias DNS also resolved twice.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/wave-02-verification/{report.md,package-wsl-targeted-workload-proof.txt}`.
- Status: verified repaired. Full all-global startup remains blocked by the separate `D11-008` privileged-port defect.

### `D11-007`: Netavark selected user-systemd Aardvark launch on a no-linger host

- Expected: the default managed rootless runtime starts containers and provides project DNS without enabling user linger or requiring a user systemd bus.
- Actual: Netavark 2.0.0 saw a systemd-booted host and `systemd-run` on inherited `PATH`, selected `systemd-run --user --scope`, and failed because `/run/user/1000/bus` was absent while `Linger=no`.
- Impact: rootless containers could not start on the dependency-free reference host unless the user made an unnecessary persistent host-policy change.
- Failure/control evidence: normal host `PATH` reproduced the exact Aardvark user-bus failure; runtime-bin-only `PATH` started rootless containers and DNS; restoring normal `PATH` restored the exact failure.
- Repair: managed runtime Podman receives process-scoped `PATH=/home/aaron/.local/share/lando/runtime/bin`. This hides host `systemd-run` only from the managed daemon tree and activates Netavark's existing direct Aardvark launcher; no Netavark patch or host mutation is required.
- Verification: the canonical package binary replaced the managed daemon; its environment contained the exact runtime-only `PATH`. Real Mailpit start passed twice, bundled Aardvark ran directly under WSL `/init`, and disposable probes resolved `mailpit.global.internal` twice. `Linger=no` and the absent bus socket were unchanged before and after relaunch, workload, DNS, and cleanup.
- Policy invariant: no-linger operation is required for correctness. Optional linger is off by default, may only be requested explicitly for persistence across logout or boot, must be consented, and is never an automatic fallback.
- Optional-linger status: the explicit `--enable-linger` implementation and focused gates are recorded in the journal, but no verifier result appears in the required evidence sets; independent verification therefore remains pending. Linger was not enabled during this audit.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/no-linger-spike/{report.md,success-transcript.txt,failure-control-1.txt,failure-control-2.txt,cleanup-receipt.txt}` and `.local/audit-artifacts/zero-to-drupal-11/wave-02-verification/report.md`.
- Cleanup: all spike and wave containers, probe fixtures, temporary networks/images/directories, and processes were removed. Supported global stop passed twice, zero containers remained, managed Podman PID 9288 and `_ping=OK` stayed healthy, the Drupal scaffold remained intact, and worktree inventory matched baseline.
- Status: verified repaired.

### `D11-008`: rootless Traefik cannot bind privileged host ports 80/443

- Expected: the managed rootless global proxy publishes usable HTTP and HTTPS routes without requiring sysctl, capability, firewall, package, rootful-daemon, or linger changes.
- Actual: full global start fails when Traefik requests loopback host port 80 while `net.ipv4.ip_unprivileged_port_start=1024`; a direct request through the same managed Podman API fails independently with permission denied. Pasta does not bypass the kernel policy.
- Impact: all-global startup and the final Drupal database/browser journey remain blocked. An unrelated outer Caddy listener also owns host port 80, so relaxed policy alone would not provide safe ownership.
- Policy invariant: keep the managed runtime rootless and do not mutate sysctl, file capabilities, firewall, packages, linger, or daemon privilege. Bare implicit 80/443 URLs cannot be promised without an administrator-owned privileged ingress.
- High-port proof: rootless Podman published Traefik twice as `127.0.0.1:38080 -> :80` and `127.0.0.1:38443 -> :443`. HTTP and HTTPS Host routing returned 200, and a disposable official Drupal 11 container rendered `Choose language | Drupal` at both `http://appserver.drupal11-audit.lndo.site:38080/` and `https://appserver.drupal11-audit.lndo.site:38443/`.
- Remaining repair: preserve the selected host binding through endpoint planning, compose adaptation, provider rendering, route output, `lando open`, and `lando info`; redirects must retain `:38443`, and Drupal must trust forwarded scheme/authority so HTTPS absolute URLs do not regress to `http://`.
- Evidence: `.local/audit-artifacts/zero-to-drupal-11/rootless-port-spike/{report.md,02-control-global-start.txt,03-control-direct-podman.txt,06-route-proof.txt,09-drupal-route-proof.txt,10-final-cleanup.txt}`.
- Cleanup: no containers, disposable network/config/image, or 38080/38443 listeners remain; sysctl is still 1024, helper capabilities remain unset, `Linger=no`, managed Podman PID 9288 returns `_ping=OK`, and the Drupal scaffold is intact.
- Status: defect and non-invasive mechanism verified; production repair and independent end-to-end verification pending. The disposable installer route proves ingress feasibility only, not Composer/Drush installation, database operation, browser login, or completion of this journey.

## Final Assessment

`D11-005`, `D11-006`, and `D11-007` are verified repaired with the canonical package-built binary. `D11-008` is a confirmed rootless privileged-port blocker with a verified high-port mechanism but no completed product repair. Optional linger remains off by default, was not enabled, and still awaits independent verification of its explicit opt-in path. Drupal installation against the Lando-managed database, database query, real-browser render/login, and the clean-snapshot repeat all remain pending; the zero-to-Drupal-11 journey is not complete.
