import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ProviderUnavailableError, ScannerError } from "@lando/sdk/errors";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { HttpClient, RuntimeProvider, type RuntimeProviderShape, UrlScanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { UrlScannerDefaultLayer, UrlScannerLive } from "../../../src/subsystems/scanner/live.ts";
import { appId, asHttpClient, drive, driveExit, failureOf, httpStatus, requestSequence } from "./support.ts";

const web = ServiceName.make("web");
const worker = ServiceName.make("worker");

const provideScanner = (provider: RuntimeProviderShape, http: ReturnType<typeof requestSequence>) =>
  Effect.gen(function* () {
    return yield* UrlScanner;
  }).pipe(
    Effect.provide(UrlScannerLive),
    Effect.provide(Layer.succeed(RuntimeProvider, provider)),
    Effect.provide(Layer.succeed(HttpClient, asHttpClient(http))),
  );

describe("UrlScannerLive", () => {
  test("wires the probe scanner from RuntimeProvider endpoints and HttpClient", async () => {
    const http = requestSequence([httpStatus(200)]);
    const provider = {
      ...TestRuntimeProvider,
      list: () =>
        Effect.succeed([
          {
            app: appId,
            service: web,
            providerId: ProviderId.make(TestRuntimeProvider.id),
            status: "running",
            endpoints: [{ protocol: "http" as const, port: 8080 }],
          },
          {
            app: appId,
            service: worker,
            providerId: ProviderId.make(TestRuntimeProvider.id),
            status: "running",
            state: "stopped",
            endpoints: [{ protocol: "http" as const, port: 9090 }],
          },
        ]),
    } satisfies RuntimeProviderShape;

    const result = await drive(
      provideScanner(provider, http).pipe(Effect.flatMap((scanner) => scanner.scan(appId))),
    );

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(result.endpoints[0]?.url).toBe("http://localhost:8080/");
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(UrlScannerDefaultLayer).toBe(UrlScannerLive);
  });

  test("maps provider list failures to ScannerError", async () => {
    const http = requestSequence([httpStatus(200)]);
    const provider = {
      ...TestRuntimeProvider,
      list: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: TestRuntimeProvider.id,
            operation: "list",
            message: "provider saw MY_TOKEN=abc123",
          }),
        ),
    } satisfies RuntimeProviderShape;

    const exit = await driveExit(
      provideScanner(provider, http).pipe(Effect.flatMap((scanner) => scanner.scan(appId))),
    );
    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(ScannerError);
    if (failure instanceof ScannerError) {
      expect(failure.scannerId).toBe("http-probe");
      expect(failure.message).not.toContain("abc123");
      expect(failure.message).toContain("[redacted]");
    }
  });
});
