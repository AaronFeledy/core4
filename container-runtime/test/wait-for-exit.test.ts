import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { dockerWaitDialect, libpodWaitDialect } from "../src/dialect.ts";
import type { WaitDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { waitForExit } from "../src/wait-for-exit.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("wait-for-exit-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "container-runtime/wait-for-exit.test.ts",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: appId,
  name: "Wait For Exit App",
  slug: "wait-for-exit-app",
  root: AbsolutePath.make("/tmp/wait-for-exit-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const target = { app: appId, service: serviceName };
const ctx = { providerId: "docker", remediation: "Inspect the engine and retry." } as const;

const makeFakeApi = (responses: ReadonlyArray<EngineHttpResponse>) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (input) => {
      calls.push(input);
      return Effect.succeed(responses[calls.length - 1] ?? { status: 500, body: "" });
    },
  };
  return { api, calls };
};

type DialectCase = readonly [name: string, dialect: WaitDialect, body: (exitCode: number) => string];
const dialects: ReadonlyArray<DialectCase> = [
  ["docker", dockerWaitDialect, (exitCode) => JSON.stringify({ StatusCode: exitCode })],
  ["libpod", libpodWaitDialect, (exitCode) => JSON.stringify(exitCode)],
];

describe.each(dialects)("%s waitForExit", (_name, dialect, body) => {
  test("returns exit code zero", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: body(0) }]);

    // When
    const result = await Effect.runPromise(waitForExit(plan, target, { api: fake.api, ctx, dialect }));

    // Then
    expect(result).toEqual({ exitCode: 0 });
  });

  test("preserves the exact non-zero exit code", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: body(137) }]);

    // When
    const result = await Effect.runPromise(waitForExit(plan, target, { api: fake.api, ctx, dialect }));

    // Then
    expect(result).toEqual({ exitCode: 137 });
  });

  test("uses only the dialect wait request", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: body(0) }]);

    // When
    await Effect.runPromise(waitForExit(plan, target, { api: fake.api, ctx, dialect }));

    // Then
    expect(fake.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: dialect.request("lando-wait-for-exit-app-web").path },
    ]);
  });

  test("forwards cancellation to the wait request", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: body(0) }]);
    const controller = new AbortController();

    // When
    await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect, signal: controller.signal }),
    );

    // Then
    expect(fake.calls[0]?.signal).toBe(controller.signal);
  });

  test("fails with ProviderUnavailableError for non-2xx", async () => {
    // Given
    const fake = makeFakeApi([{ status: 500, body: '{"message":"wait failed"}' }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toBe("Container wait failed with HTTP 500. wait failed");
  });

  test("fails with ProviderInternalError for a non-numeric exit code", async () => {
    // Given
    const invalidBody = dialect === dockerWaitDialect ? '{"StatusCode":null}' : "null";
    const fake = makeFakeApi([{ status: 200, body: invalidBody }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
    expect(failure.message).toBe("Container wait did not return a numeric container exit code.");
    expect(failure.remediation).toBe(ctx.remediation);
  });
});

describe("waitForExit failures", () => {
  test("fails with ServiceNotFoundError when the service is absent", async () => {
    // Given
    const missingTarget = { app: appId, service: ServiceName.make("missing") };

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, missingTarget, { api: makeFakeApi([]).api, ctx, dialect: dockerWaitDialect }).pipe(
        Effect.flip,
      ),
    );

    // Then
    expect(failure).toBeInstanceOf(ServiceNotFoundError);
  });

  test("fails with ProviderUnavailableError when request support is absent", async () => {
    // Given / When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: {}, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
  });

  test("treats an empty successful body as a non-numeric response", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: "" }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
    expect(failure.message).toBe("Container wait did not return a numeric container exit code.");
  });

  test("rejects malformed JSON with the shared internal error", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: "not-json" }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
    expect(failure.message).toBe("Container engine API returned malformed JSON.");
  });

  test("uses the supplied podman context on failures", async () => {
    // Given
    const podmanCtx = { providerId: "podman", remediation: "Repair Podman and retry." } as const;
    const fake = makeFakeApi([{ status: 500, body: "" }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx: podmanCtx, dialect: libpodWaitDialect }).pipe(
        Effect.flip,
      ),
    );

    // Then
    expect(failure.providerId).toBe("podman");
    expect(failure.remediation).toBe(podmanCtx.remediation);
  });
});
