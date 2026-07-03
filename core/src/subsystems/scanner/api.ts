/**
 * `UrlScanner` service interface.
 *
 * URL scanner behaviors:
 * - After start, the active `UrlScanner` probes host-facing URLs.
 * - Scanner config: `enabled`, `retry`, `delay`, `timeout`, `path`,
 *   `okCodes`, `maxRedirects`.
 * - Per-service overrides under `services.<name>.scanner:`.
 * - Results are reported as green/yellow/red with optional structured detail.
 *   The default scanner lives in `live.ts`, builds `retry`/`delay`/`timeout`
 *   behavior on `@lando/sdk/probe`'s `runProbe`, and redacts probe failure
 *   details before surfacing them.
 * - This module keeps the explicit degraded-mode layer for contexts where no
 *   runtime provider is available.
 */
import { Effect, Layer } from "effect";

import { ScannerError } from "@lando/sdk/errors";
import { UrlScanner } from "@lando/sdk/services";

export { UrlScanner };

const SCANNER_UNAVAILABLE_ID = "unavailable" as const;
const SCANNER_UNAVAILABLE_MESSAGE =
  "UrlScanner requires a running provider. Run `lando setup` to install the provider.";

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
