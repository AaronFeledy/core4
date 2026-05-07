/**
 * `UrlScanner` service interface.
 *
 * URL scanner behaviors:
 * - After start, the active `UrlScanner` probes host-facing URLs.
 * - Scanner config: `enabled`, `retry`, `delay`, `timeout`, `path`,
 *   `okCodes`, `maxRedirects`.
 * - Per-service overrides under `services.<name>.scanner:`.
 * - Results are reported as green/yellow/red with optional structured
 *   detail.
 */
export { UrlScanner } from "@lando/sdk/services";
