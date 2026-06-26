/**
 * `UrlScanner` service interface.
 *
 * URL scanner behaviors:
 * - After start, the active `UrlScanner` probes host-facing URLs.
 * - Scanner config: `enabled`, `retry`, `delay`, `timeout`, `path`,
 *   `okCodes`, `maxRedirects`.
 * - Per-service overrides under `services.<name>.scanner:`.
 * - Results are reported as green/yellow/red with optional structured
 *   detail. The full scanner is not implemented yet; when it lands, its
 *   `retry`/`delay`/`timeout` loop and green/yellow/red verdict must build on
 *   `@lando/sdk/probe`'s `runProbe` rather than a hand-rolled
 *   `Effect.retry`/`Schedule` loop (enforced by the probe boundary gate), and
 *   must redact `ProbeResult.lastError` before it reaches an event or
 *   transcript.
 */
import { Effect, Layer } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import { UrlScanner } from "@lando/sdk/services";

export { UrlScanner };

const SCANNER_UNAVAILABLE_ID = "unavailable" as const;
const SCANNER_UNAVAILABLE_MESSAGE =
  "UrlScanner requires a running provider. Run `lando setup` to install the provider (full implementation is not available yet).";

export const UrlScannerUnavailableLive = Layer.succeed(UrlScanner, {
  id: SCANNER_UNAVAILABLE_ID,
  scan: (_appId) =>
    Effect.fail(
      new ScannerError({ message: SCANNER_UNAVAILABLE_MESSAGE, scannerId: SCANNER_UNAVAILABLE_ID }),
    ),
  detectCollisions: (_appIds) =>
    Effect.fail(
      new ScannerError({ message: SCANNER_UNAVAILABLE_MESSAGE, scannerId: SCANNER_UNAVAILABLE_ID }),
    ),
});
