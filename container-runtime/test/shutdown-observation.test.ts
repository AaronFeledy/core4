import { expect, test } from "bun:test";
import { ProviderInternalError, type ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, ProviderId, ServiceName, ServiceShutdownObservation } from "@lando/sdk/schema";
import { Deferred, Effect, Fiber, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { stopAndRemoveContainer } from "../src/stop-container.ts";

const identity = {
  appId: AppId.make("app"),
  providerId: ProviderId.make("podman"),
  service: ServiceName.make("web"),
  containerId: "exact-owned-id",
};
const ctx = { providerId: "podman", remediation: "repair-runtime", env: { API_TOKEN: "secret-value-123" } };
const run = (state: unknown, stopStatus = 204) =>
  Effect.runPromise(
    stopAndRemoveContainer(identity, {
      ctx,
      api: {
        request: (input) =>
          Effect.succeed(
            input.method === "POST"
              ? { status: stopStatus, body: "" }
              : input.method === "GET"
                ? { status: 200, body: JSON.stringify(state) }
                : { status: 204, body: "" },
          ),
      },
    }),
  );

test.each([0, 143, 137])("reports daemon exit %i without a shutdown verdict", async (exitCode) => {
  // Given / When
  const result = await run({ State: { Status: "exited", ExitCode: exitCode } });
  // Then
  expect(result.shutdownObservations).toEqual([{ ...identity, status: "exited", exitCode }]);
  expect(Schema.is(ServiceShutdownObservation)(result.shutdownObservations[0])).toBe(true);
});

test.each([true, false, undefined])("preserves explicitly reported OOM %s", async (oomKilled) => {
  // Given / When
  const result = await run(
    {
      State: {
        Status: "exited",
        ExitCode: 137,
        ...(oomKilled === undefined ? {} : { OOMKilled: oomKilled }),
      },
    },
    304,
  );
  // Then
  expect(result.shutdownObservations).toEqual([
    { ...identity, status: "exited", exitCode: 137, ...(oomKilled === undefined ? {} : { oomKilled }) },
  ]);
});

test.each([
  [{}, "state-unavailable"],
  [{ State: null }, "state-unavailable"],
  [{ State: {} }, "state-unavailable"],
  [{ State: { OOMKilled: true } }, "state-unavailable"],
  [{ State: { Status: "created", ExitCode: 0, OOMKilled: false } }, "not-exited"],
  [{ State: { Status: "running", Running: true, ExitCode: 0 } }, "not-exited"],
] as const)("reports unknown for incomplete or never-started state %j", async (state, reason) => {
  // Given / When
  const result = await run(state);
  // Then
  expect(result.shutdownObservations[0]).toMatchObject({ ...identity, status: "unknown", reason });
  expect(result.shutdownObservations[0]).not.toHaveProperty("exitCode");
});

test("does not invent a missing exit code", async () => {
  // Given / When
  const result = await run({ State: { Status: "exited", OOMKilled: true } });
  // Then
  expect(result.shutdownObservations).toEqual([{ ...identity, status: "exited", oomKilled: true }]);
});

test("retains an OOM bit when other state fields are malformed", async () => {
  const result = await run({ State: { Status: "exited", ExitCode: "not-an-integer", OOMKilled: true } });
  expect(result.shutdownObservations).toEqual([{ ...identity, status: "exited", oomKilled: true }]);
});

test("inspection is bounded and cleanup continues after the deadline", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const inspecting = yield* Deferred.make<void>();
      const calls: string[] = [];
      const work = stopAndRemoveContainer(identity, {
        ctx,
        api: {
          request: (input) => {
            calls.push(input.method);
            return input.method === "GET"
              ? Effect.andThen(Deferred.succeed(inspecting, undefined), Effect.never)
              : Effect.succeed({ status: 204, body: "" });
          },
        },
      });
      const child = yield* Effect.forkChild(work);
      yield* Deferred.await(inspecting);
      yield* TestClock.adjust("5 seconds");
      return { receipt: yield* Fiber.join(child), calls };
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.calls).toEqual(["POST", "GET", "DELETE"]);
  expect(result.receipt.shutdownObservations[0]).toMatchObject({
    status: "unknown",
    reason: "inspect-failed",
    diagnostic: { _tag: "ProviderUnavailableError" },
  });
});

test("inspection failure is sanitized and exact-id deletion continues", async () => {
  // Given
  const calls: EngineHttpRequest[] = [];
  const cause = new ProviderInternalError({
    providerId: "podman",
    operation: "request",
    message: "secret-value-123 failed",
    remediation: "retry secret-value-123",
    details: { body: "raw-inspect-bytes" },
  });
  // When
  const result = await Effect.runPromise(
    stopAndRemoveContainer(identity, {
      ctx,
      api: {
        request: (input) => {
          calls.push(input);
          return input.method === "GET" ? Effect.fail(cause) : Effect.succeed({ status: 204, body: "" });
        },
      },
    }),
  );
  // Then
  expect(result.kind).toBe("removed");
  expect(result.shutdownObservations[0]).toMatchObject({
    status: "unknown",
    reason: "inspect-failed",
    diagnostic: { _tag: "ProviderInternalError" },
  });
  expect(JSON.stringify(result)).not.toContain("secret-value-123");
  expect(JSON.stringify(result)).not.toContain("raw-inspect-bytes");
  expect(Schema.is(ServiceShutdownObservation)(result.shutdownObservations[0])).toBe(true);
  expect(calls.map((call) => call.path)).toEqual([
    "/containers/exact-owned-id/stop",
    "/containers/exact-owned-id/json",
    "/containers/exact-owned-id?force=true&v=true",
  ]);
});

test("stop absence skips inspect and delete", async () => {
  // Given / When
  const result = await run({}, 404);
  // Then
  expect(result).toEqual({
    changed: false,
    kind: "absent",
    shutdownObservations: [{ ...identity, status: "unknown", reason: "container-absent" }],
  });
});

test.each(["POST", "DELETE"] as const)(
  "preserves %s transport failure identity and cause",
  async (method) => {
    // Given
    const cause = new ProviderInternalError({
      providerId: "podman",
      operation: "original",
      message: "transport failed",
      remediation: "repair transport",
    });
    const api = {
      request: (
        input: EngineHttpRequest,
      ): Effect.Effect<EngineHttpResponse, ProviderInternalError | ProviderUnavailableError> =>
        input.method === method
          ? Effect.fail(cause)
          : Effect.succeed({
              status: input.method === "GET" ? 200 : 204,
              body: '{"State":{"Status":"exited","ExitCode":143}}',
            }),
    };
    // When
    const result = await Effect.runPromise(Effect.result(stopAndRemoveContainer(identity, { api, ctx })));
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ProviderInternalError",
        operation: "original",
        remediation: "repair transport",
      });
      if (method === "POST") expect(result.failure).toBe(cause);
      else
        expect(result.failure).toMatchObject({
          cause,
          details: { shutdownObservations: [{ exitCode: 143 }] },
        });
    }
  },
);
