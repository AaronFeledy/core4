import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";

import type { DataPlaneApiClient } from "@lando/container-runtime/data-plane";
import { makeProviderLogSourceBinding } from "@lando/container-runtime/log-source-binding";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import { AbsolutePath } from "@lando/sdk/schema";
const target = { os: "linux", arch: "x64" } as const;
const resolveHelper = () =>
  Effect.succeed({ target, path: AbsolutePath.make(import.meta.filename), digest: "1".repeat(64) });

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
      sourceEnv: {},
      providerId: "docker",
      logFileAccess: memory.access,
      helperTarget: target,
      resolveHelper,
    });
    // When: the bound source reads the injected file.
    const access = binding.bind(api, "fallback-container").logFileAccess;
    if (access === undefined || Effect.isEffect(access)) throw new Error("Expected injected access");
    const stat = await Effect.runPromise(access.stat("/app.log"));
    // Then: the override, not the helper, supplies the content.
    expect(Option.getOrThrow(stat).size).toBe(9n);
    expect(calls).toEqual([]);
  });

  for (const unavailable of ["resolver", "api", "container"] as const) {
    test(`omits helper access when ${unavailable} is unavailable`, () => {
      // Given: one missing helper prerequisite.
      const binding = makeProviderLogSourceBinding({
        sourceEnv: {},
        providerId: "lando",
        logFileAccess: undefined,
        helperTarget: target,
        resolveHelper: unavailable === "resolver" ? undefined : resolveHelper,
      });
      // When: access is bound.
      const source = binding.bind(
        unavailable === "api" ? undefined : {},
        unavailable === "container" ? undefined : "service",
      );
      // Then: no unusable helper is constructed; support remains a provider policy input.
      expect(source).toEqual({});
      expect(binding.supported).toBe(unavailable !== "resolver");
    });
  }

  test("keeps injected access available without helper prerequisites", () => {
    // Given: only injected access.
    const memory = makeMemoryLogFileAccess();
    const binding = makeProviderLogSourceBinding({
      sourceEnv: {},
      providerId: "lando",
      logFileAccess: memory.access,
      helperTarget: undefined,
      resolveHelper: undefined,
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
      sourceEnv: {},
      providerId: "podman",
      logFileAccess: undefined,
      helperTarget: target,
      resolveHelper,
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
    const access = source.logFileAccess;
    if (!Effect.isEffect(access)) throw new Error("Expected scoped helper access");
    // When: the helper attempts to stat a file.
    const result = await Effect.runPromise(Effect.result(Effect.scoped(access)));
    // Then: upload targets the bound container and failure retains provider identity.
    expect(calls).toContain("/containers/service%2Fname/archive?path=/tmp");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { providerId: "podman", operation: "logFileAccess" },
    });
  });
});
