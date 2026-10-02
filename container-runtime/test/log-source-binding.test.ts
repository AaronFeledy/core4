import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";

import type { DataPlaneApiClient } from "@lando/container-runtime/data-plane";
import { makeProviderLogSourceBinding } from "@lando/container-runtime/log-source-binding";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";

describe("provider log source binding", () => {
  test("uses injected access when a different helper-backed fallback is available", async () => {
    // Given: injected file content and a fallback API that cannot install a helper.
    const memory = makeMemoryLogFileAccess();
    memory.writeFile("/app.log", "override\n");
    const calls: string[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        calls.push(request.path);
        return Effect.succeed({ status: 503, body: "fallback unavailable" });
      },
    };
    const binding = makeProviderLogSourceBinding({
      providerId: "docker",
      logFileAccess: memory.access,
      helperPayload: new Uint8Array([1]),
    });
    // When: the bound source reads the injected file.
    const access = binding.bind(api, "fallback-container").logFileAccess;
    if (access === undefined) throw new Error("Expected bound access");
    const stat = await Effect.runPromise(access.stat("/app.log"));
    // Then: the override, not the helper, supplies the content.
    expect(Option.getOrThrow(stat).size).toBe(9n);
    expect(calls).toEqual([]);
  });

  for (const unavailable of ["payload", "api", "container"] as const) {
    test(`omits helper access when ${unavailable} is unavailable`, () => {
      // Given: one missing helper prerequisite.
      const binding = makeProviderLogSourceBinding({
        providerId: "lando",
        logFileAccess: undefined,
        helperPayload: unavailable === "payload" ? undefined : new Uint8Array([1]),
      });
      // When: access is bound.
      const source = binding.bind(
        unavailable === "api" ? undefined : {},
        unavailable === "container" ? undefined : "service",
      );
      // Then: no unusable helper is constructed; support remains a provider policy input.
      expect(source).toEqual({});
      expect(binding.supported).toBe(unavailable !== "payload");
    });
  }

  test("keeps injected access available without helper prerequisites", () => {
    // Given: only injected access.
    const memory = makeMemoryLogFileAccess();
    const binding = makeProviderLogSourceBinding({
      providerId: "lando",
      logFileAccess: memory.access,
      helperPayload: undefined,
    });
    // When: neither API nor container is available.
    const source = binding.bind(undefined, undefined);
    // Then: the injected source is still usable.
    expect(source.logFileAccess).toBe(memory.access);
    expect(binding.supported).toBe(true);
  });

  test("binds the helper to the requested container and provider", async () => {
    // Given: an API that refuses uploads.
    const calls: string[] = [];
    const binding = makeProviderLogSourceBinding({
      providerId: "podman",
      logFileAccess: undefined,
      helperPayload: new Uint8Array([1]),
    });
    const source = binding.bind(
      {
        request: (request) => {
          calls.push(request.path);
          return Effect.succeed({ status: 503, body: "unavailable" });
        },
      },
      "service/name",
    );
    if (source.logFileAccess === undefined) throw new Error("Expected helper access");
    // When: the helper attempts to stat a file.
    const result = await Effect.runPromise(Effect.result(source.logFileAccess.stat("/app.log")));
    // Then: upload targets the bound container and failure retains provider identity.
    expect(calls[0]).toBe("/containers/service%2Fname/archive?path=/tmp");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { providerId: "podman", operation: "logFileAccess" },
    });
  });
});
