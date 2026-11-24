# Podman v6.0.1 API-service healthcheck scheduler patch

## Problem

Podman schedules container healthchecks only through transient systemd timers. Lando's managed Linux runtime runs `podman system service` with `DISABLE_HC_SYSTEMD=true` because a systemd user manager is often missing (WSL, CI runners, headless hosts), so no healthcheck ever runs on its own and native health never leaves `starting`. Upstream declined a scheduler inside the API service (containers/podman#27033) and plans healthchecks in conmon v3; non-systemd healthchecks are tracked in containers/podman#28192.

## Patch

`podman system service` schedules healthchecks itself when its environment has `PODMAN_SERVICE_HEALTHCHECKS=1`. Only the API service reads the variable (`restService` calls `Runtime.ServeHealthChecks`), so `podman healthcheck run`, `podman container cleanup`, and other short-lived commands never schedule. Scheduling also requires systemd timers to be off for the process (`DISABLE_HC_SYSTEMD=true`, or not running on systemd); otherwise the service logs `Not scheduling healthchecks` and runs as upstream does. Any failure to start scheduling is a warning, never a service failure.

- **Source of truth.** The scheduler re-reads each container (running and not paused, start time, healthcheck config, startup-check state, health status) and arms, re-arms, or disarms a per-container loop from that snapshot. A start time or healthcheck config change starts a new run; an unchanged run keeps its loop, so duplicate hints never reset cadence.
- **Events are hints.** The service subscribes to container `init`, `start`, `restart`, `died`, `stop`, `pause`, `unpause`, `remove`, `update`, `cleanup`, and `restore` events from a moment taken before the startup sweep (`Since` replay), so a change between the sweep and the subscription is not lost. It never subscribes to `health_status`. When the stream ends, it reconciles every container and resubscribes from that moment; when the events log cannot be read, it retries every 30 seconds from the same moment and leaves catching up to the periodic reconcile. It also reconciles every container every 30 seconds, so lifecycle changes made by other processes (for example conmon's `podman container cleanup` applying a restart policy) are picked up even if an event is missed.
- **Cadence.** The first check of a run happens at once, as Podman's timer start does; every later delay is measured from the end of the previous check. A pending startup healthcheck runs every startup interval, and the regular check starts at once when it passes. With `StartInterval` set, a container whose status is still `starting` inside its start period is checked every `StartInterval` (Docker's rule); otherwise every `Interval`. A zero interval schedules nothing.
- **Serialization and fencing.** One guard per container serializes scheduled checks, including an old run's check that is still running when a new run is armed. A manual `/libpod/containers/{name}/healthcheck` call served by the same service waits for that guard rather than returning busy. A scheduled check whose container restarted while it ran writes no log entry, streak, or startup counter. The on-failure action is fenced the same way but checked just before it runs, without the container lock, so a restart in that instant can still meet a stale action: the window is narrowed, not closed.
- **Exit code.** In a service that schedules healthchecks, a passing startup healthcheck no longer calls `shutdown.SetExitCode(0)`; that call is only meant for `podman healthcheck run` processes.
- **Acknowledgement file.** Once the startup sweep has armed every running container, the service atomically writes `<runroot>/healthcheck-scheduler.pid` containing its decimal PID and a newline (mode 0644). It registers its shutdown handler before writing the file, and removes the file, if it still names its own PID, when scheduling stops: on SIGINT/SIGTERM through that handler, or when `Serve` returns. A SIGKILLed service leaves a file that names a dead PID; the next opted-in service overwrites it. Consumers must check that the PID is the service they launched.
- **Shutdown.** Stopping cancels every loop and waits at most 5 seconds for checks in flight. `healthCheckExec` takes no context, so a check still running after that is ended by its own healthcheck timeout.
- **One service per storage.** Only one opted-in service per storage is supported; a second one would check every container again. A second service started without the variable never schedules.

New code lives in `pkg/hcschedule` (pure scheduling, reconciliation, cadence, and per-container guards, with unit tests that run in `testing/synctest` bubbles on virtual time) and `libpod/healthcheck_service.go`; `restService` gains one line and the other existing files a few lines each, all additive except the exit-code guard. The bundle builder verifies the patch file, every pre-image, and every post-image before and after applying this unified diff with zero fuzz.

- Source archive: `https://github.com/containers/podman/archive/refs/tags/v6.0.1.tar.gz`
- Source archive SHA-256: `4829d7c1423523a6a4d5537dea7968ae7f6c22ed7f1d5f416638fd81c83caa47`
- Patch SHA-256: `99878cb3921a1c6f384c22dbd9d765d30610dd9d87c827056408dd341c74acb9`

| File | Source SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `cmd/podman/system/service_abi.go` | `3556ad36e58d878fc615f4a6ef82d6f768060817841ea93297aad3ae25d86280` | `19a366261f3484829f36e81c1720d994c7e463db3f6640b1e10984ccf5739622` |
| `libpod/healthcheck.go` | `4b6735b8b5a1dcba3b680769488d27296afae595a01d77cad2f4f3aaf516ded6` | `e113bbe289eef02172308ee36ea270c0ede7ebed8bca3238ec91fe7e3de18943` |
| `libpod/healthcheck_linux.go` | `c5589a69705c903daaaea53c61cdd758adc9ed08a0296e9124f6f2d5f446a71b` | `acdb5ff76114b2fd5337521f88170371d92bf5d08bdda33be39a905a3f6250cb` |
| `libpod/healthcheck_nosystemd_linux.go` | `43bd87fbd310378a1bd77ebcb4bf45c08d26f2e634a1a5ad73c634f8a661ad96` | `22e89be5c46cc661ec559287be5ebd7000367b79e95d4e9d2770ff8807a950e9` |
| `libpod/healthcheck_service.go` | new file | `4f88ff4bb8863454cc18389902cd497347ceff1fb483af1b47381e9524b59b9e` |
| `libpod/healthcheck_service_test.go` | new file | `9b0223be97bb2d41a2d7f252bc78900011e527306046b36ca739bf9213bd893f` |
| `libpod/healthcheck_unsupported.go` | `a82a3876297da95dabdea0e5b0daab72353230a707dc4e9ef6904dcaba65036f` | `22da5525c3229a50d543c9bc0dd6f4c25def61ac3b1b0ad510f35e4beb4ba869` |
| `pkg/hcschedule/cadence.go` | new file | `ae8dcf3232b37e2ba3ace12e81aaa1fa66fd3dbc90b5debf112aaccfe08fa048` |
| `pkg/hcschedule/cadence_test.go` | new file | `d00220a338149856f0dcc6cad6a05d59eeb7ce1cfe8aa639aa55d7b9852edd11` |
| `pkg/hcschedule/guards.go` | new file | `03888bb707aa10ebe3826562e1c950fea1fcc6ecfd616fc805f8494a0e1f6050` |
| `pkg/hcschedule/guards_test.go` | new file | `46955e0bb9e960fdf3635666b27df8854af5909a417f56b8a822c9e2a8459c71` |
| `pkg/hcschedule/scheduler.go` | new file | `24a7156eb3770a9f2a316907f72368b26b864e88db4a0c6369eaef6176b42bf7` |
| `pkg/hcschedule/scheduler_test.go` | new file | `a0f2ea2cafe75ade3296fea860bd4faa92a16bccb9a895fdfb987598e789e466` |

- Upstream tracking: containers/podman#28192 (non-systemd healthchecks), containers/podman#27033 (declined service scheduler), and integrated healthchecks planned for conmon v3.

## Removal condition

Drop this patch when Podman or conmon v3 schedules healthchecks without systemd for the managed runtime (containers/podman#28192 resolved), remove `PODMAN_SERVICE_HEALTHCHECKS` from Lando's managed launch, and keep the managed-runtime health guide scenarios passing without the diff.
