import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { containerRemovalArgs, removeRuntimeContainer } from "../src/container-removal.ts";
import type { EngineHttpRequest } from "../src/engine-api.ts";

const ctx = { providerId: "podman", operation: "cleanup", remediation: "Retry cleanup.", env: {} };

describe("checked container removal", () => {
  for (const status of [200, 204, 404]) {
    test(`reports removal accurately when the engine returns ${status}`, async () => {
      // Given
      const requests: EngineHttpRequest[] = [];
      const api = {
        request: (request: EngineHttpRequest) => {
          requests.push(request);
          return Effect.succeed({ status, body: "" });
        },
      };
      // When
      const removed = await Effect.runPromise(removeRuntimeContainer(api, "id/a%20b", ctx));
      // Then
      expect(removed).toBe(status !== 404);
      expect(requests).toEqual([{ method: "DELETE", path: "/containers/id%2Fa%2520b?force=true&v=true" }]);
    });
  }

  test("fails when the engine rejects deletion", async () => {
    // Given
    const api = { request: () => Effect.succeed({ status: 500, body: "engine unavailable" }) };
    // When
    const result = await Effect.runPromise(Effect.result(removeRuntimeContainer(api, "id", ctx)));
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderUnavailableError", operation: "cleanup" },
    });
  });

  test("preserves a transport failure when deletion cannot reach the engine", async () => {
    // Given
    const failure = new ProviderUnavailableError({ ...ctx, message: "Connection refused" });
    // When
    const result = await Effect.runPromise(
      Effect.result(removeRuntimeContainer({ request: () => Effect.fail(failure) }, "id", ctx)),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure });
  });

  test("fails when no request transport is available", async () => {
    // Given / When
    const result = await Effect.runPromise(Effect.result(removeRuntimeContainer({}, "id", ctx)));
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  });

  test("requests attached anonymous volume removal for exact CLI references", () => {
    // Given / When / Then
    expect(containerRemovalArgs(["first", "second"])).toEqual(["rm", "-f", "--volumes", "first", "second"]);
  });
});
