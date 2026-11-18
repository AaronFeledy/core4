import { describe, expect, test } from "bun:test";
import { ProviderInternalError, ProviderUnavailableError, ServiceNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect";
import type { WaitDialect } from "../src/dialect.ts";
import { dockerWaitDialect, libpodWaitDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { waitForExit, waitNativeContainer } from "../src/wait-for-exit.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("wait-for-exit-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-26T00:00:00Z"),
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
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const target = { app: appId, service: serviceName };
const ctx = { providerId: "docker", remediation: "Inspect the engine and retry.", env: {} } as const;

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
      { method: "POST", path: dialect.request("lando-wait-for-exit-app--web").path },
    ]);
  });

  test("aborting a pending native wait cancels transport and interrupts the caller", async () => {
    const { exit, transportAborted } = await Effect.runPromise(
      Effect.gen(function* () {
        const armed = yield* Deferred.make<AbortSignal>();
        const controller = new AbortController();
        const api: EngineHttpApi = {
          request: () =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise<EngineHttpResponse>((_resolve, reject) => {
                  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                  Effect.runSync(Deferred.succeed(armed, signal));
                }),
              catch: () =>
                new ProviderUnavailableError({
                  providerId,
                  operation: "wait",
                  message: "Transport aborted",
                  remediation: ctx.remediation,
                }),
            }),
        };
        const fiber = yield* Effect.forkChild(
          waitForExit(plan, target, { api, ctx, dialect, signal: controller.signal }),
        );
        const transport = yield* Deferred.await(armed);
        controller.abort();
        return { exit: yield* Fiber.await(fiber), transportAborted: transport.aborted };
      }),
    );

    expect(transportAborted).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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
    expect(failure).toMatchObject({ details: { status: 200, body: "not-json" } });
  });

  test("uses the supplied podman context on failures", async () => {
    // Given
    const podmanCtx = { providerId: "podman", remediation: "Repair Podman and retry.", env: {} } as const;
    const fake = makeFakeApi([{ status: 500, body: "" }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx: podmanCtx, dialect: libpodWaitDialect }).pipe(
        Effect.flip,
      ),
    );

    // Then
    expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", providerId: "podman" });
    expect(failure.remediation).toBe(podmanCtx.remediation);
  });
});

describe("waitNativeContainer", () => {
  test("returns Returned with the exit code for a verified id", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: JSON.stringify({ StatusCode: 7 }) }]);

    // When
    const result = await Effect.runPromise(
      waitNativeContainer("abc123", { api: fake.api, ctx, dialect: dockerWaitDialect }),
    );

    // Then
    expect(result).toEqual({ _tag: "Returned", exitCode: 7 });
    expect(fake.calls.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/containers/abc123/wait" },
    ]);
  });

  test("returns Missing for 404 at the wait endpoint", async () => {
    // Given
    const fake = makeFakeApi([{ status: 404, body: '{"message":"No such container: abc123"}' }]);

    // When
    const result = await Effect.runPromise(
      waitNativeContainer("abc123", { api: fake.api, ctx, dialect: dockerWaitDialect }),
    );

    // Then
    expect(result).toEqual({ _tag: "Missing" });
  });

  test("propagates non-404 engine failures", async () => {
    // Given
    const fake = makeFakeApi([{ status: 500, body: '{"message":"wait failed"}' }]);

    // When
    const failure = await Effect.runPromise(
      waitNativeContainer("abc123", { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
  });

  test("rejects Docker wait Error payloads as protocol errors", async () => {
    // Given
    const fake = makeFakeApi([
      { status: 200, body: JSON.stringify({ StatusCode: 0, Error: { Message: "removal failed" } }) },
    ]);

    // When
    const failure = await Effect.runPromise(
      waitNativeContainer("abc123", { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
    expect(failure.message).toBe("Container wait did not return a numeric container exit code.");
  });

  test("rejects sentinel negative exit codes", async () => {
    // Given
    const fake = makeFakeApi([{ status: 200, body: JSON.stringify({ StatusCode: -1 }) }]);

    // When
    const failure = await Effect.runPromise(
      waitNativeContainer("abc123", { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });
});

describe("waitForExit Missing translation", () => {
  test("maps native Missing to ServiceNotFoundError without changing the public success shape", async () => {
    // Given
    const fake = makeFakeApi([{ status: 404, body: '{"message":"No such container"}' }]);

    // When
    const failure = await Effect.runPromise(
      waitForExit(plan, target, { api: fake.api, ctx, dialect: dockerWaitDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ServiceNotFoundError);
    expect(failure).toMatchObject({ service: serviceName, operation: "waitForExit" });
  });
});
