/**
 * `ProcessRunner` service — `Bun.spawn` wrapper.
 *
 * `Bun.spawn` is the subprocess primitive everywhere. `node:child_process`
 * is forbidden in core except behind a `ProcessRunner` adapter that may
 * need it for plugin compatibility.
 *
 * Replaceable for telemetry, sandboxing, dry-run modes.
 *
 * Status: stub.
 */
export { ProcessRunner } from "@lando/sdk/services";
