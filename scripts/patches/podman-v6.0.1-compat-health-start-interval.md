# Podman v6.0.1 compat healthcheck start interval patch

## Problem

Lando creates containers through the Docker-compatible `/containers/create` endpoint and sends `Healthcheck.StartInterval`. Podman v6.0.1 stores that field in libpod but the compat path drops it: the create handler converts the healthcheck into CLI options that have no start interval, `applyHealthCheckOverrides` does not copy it over an image healthcheck, and compat inspect does not report it.

## Patch

The compat create handler copies a positive `Healthcheck.StartInterval` onto the generated spec, `applyHealthCheckOverrides` copies a non-zero override, and compat inspect returns `StartInterval`. An image healthcheck's start interval is still inherited when the request sets none. The scheduler in `podman-v6.0.1-service-healthchecks.patch` applies the value. A unit test covers the override and inheritance. The bundle builder applies this patch after the scheduler patch with the same zero-fuzz and SHA-256 checks.

- Source archive: `https://github.com/containers/podman/archive/refs/tags/v6.0.1.tar.gz`
- Source archive SHA-256: `4829d7c1423523a6a4d5537dea7968ae7f6c22ed7f1d5f416638fd81c83caa47`
- Patch SHA-256: `0100f13ff5a544711991fe424a2f58d9caf5b71beaf6a0f96583cb14c14b041f`

| File | Source SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `pkg/api/handlers/compat/containers.go` | `1afcd97461d13f58da4ebf0749b91043aad31753b20d5e22aef9b9da13b0dd10` | `5ad7aa1b290f9d5bda928627bb3624e2365124e78dc660aefab2e2a5c086ee41` |
| `pkg/api/handlers/compat/containers_create.go` | `f28ac1b53fa12499ded3e8ce127c7787a66599d8c83a451a47321c53d33ec872` | `068c654be013d115dcd9dce703bc97bf3a2a9bf495b6f743cb9bfc084e152f00` |
| `pkg/specgen/generate/container.go` | `5a8b96ee35b4d209b7a7ed5328bcb9ea889d604034b213dd70b049952dd46975` | `c528ab15ae222ca6e79562befde8e8c6807ffaac874dc51f75e0430863d58c58` |
| `pkg/specgen/generate/healthcheck_start_interval_test.go` | new file | `9245d8ae2c66df8c41a00d93e4243614a15d39d9c2e540ce80047f76ea97290e` |

- Upstream tracking: a plain bug report against containers/podman ("Docker-compat create and inspect drop `Healthcheck.StartInterval`") with this diff offered as the fix.

## Removal condition

Drop this patch when the pinned Podman release preserves `Healthcheck.StartInterval` through compat create and inspect, which the managed-runtime start-interval guide scenario proves without the diff.
