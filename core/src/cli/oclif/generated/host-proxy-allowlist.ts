/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-host-proxy-allowlist.ts`.
 *
 * Source of truth: every `LandoCommandSpec` with `hostProxyAllowed: true`.
 *
 * This is deliberately a literal-data module with no command or Effect imports,
 * so the host-proxy dispatcher can read the runLando allowlist without pulling
 * the compiled CLI command graph into scope (a cold-start regression).
 */

export const HOST_PROXY_RUNLANDO_ALLOWLIST: ReadonlyArray<string> = ["app:open"];
