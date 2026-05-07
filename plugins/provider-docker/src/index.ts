/**
 * `@lando/provider-docker` — reference Docker RuntimeProvider.
 *
 * Demonstrates:
 *   - Capability matrix population via `docker version` introspection.
 *   - Buildx/BuildKit-based artifact build with secrets and SSH forwarding.
 *   - Compose-file emission to a per-app temp directory (compose is an
 *     *internal* implementation detail of this provider).
 *   - `Bun.spawn`-driven `docker exec`, with stdio, TTY, and signal
 *     forwarding.
 *   - A `Stream<LogChunk>` implementation backed by `docker logs --follow`.
 *   - Provider-extension schema for compose passthrough, native labels,
 *     registry credentials.
 *
 * Status: stub. Provider implementation lands at `./src/provider.ts`.
 */
export const PLUGIN_NAME = "@lando/provider-docker" as const;
