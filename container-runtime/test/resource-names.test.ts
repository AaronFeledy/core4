import { expect, test } from "bun:test";
import { Effect, Either } from "effect";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { inspectEngineResourceNames } from "../src/resource-names.ts";

const ctx = { providerId: "test", remediation: "Start the test engine." };

test("filters volume names strictly when the engine returns substring matches", async () => {
  // Given
  const requests: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(request);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify({
          Volumes: [
            { Name: "old-z", Labels: { app: "a=b" } },
            { Name: "old-a", Labels: { app: "a=b" } },
            { Name: "old-a", Labels: { app: "a=b" } },
            { Name: "xold-a", Labels: { app: "a=b" } },
            { Name: "old-b", Labels: { app: "wrong" } },
            { Name: "old-c", Labels: { app: "a=b", "dev.lando.anything": "" } },
          ],
        }),
      });
    },
  };
  // When
  const names = await Effect.runPromise(
    inspectEngineResourceNames(
      api,
      {
        kind: "volume",
        namePrefix: "old-",
        label: { key: "app", value: "a=b" },
        limit: 1,
      },
      ctx,
    ),
  );
  // Then
  expect(names).toEqual(["old-a"]);
  expect(requests).toEqual([
    {
      method: "GET",
      path: `/volumes?filters=${encodeURIComponent(JSON.stringify({ name: ["old-"], label: ["app=a=b"] }))}`,
    },
  ]);
});

test("strips container slashes and excludes owned resources when inspecting all containers", async () => {
  // Given
  const requests: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(request);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify([
          { Names: ["/old-z", "/old-a", "/old-a", "/other"], Labels: {} },
          { Names: ["/old-owned"], Labels: { "dev.lando.app": "x" } },
        ]),
      });
    },
  };
  // When
  const names = await Effect.runPromise(
    inspectEngineResourceNames(api, { kind: "container", namePrefix: "old-", limit: 64 }, ctx),
  );
  // Then
  expect(names).toEqual(["old-a", "old-z"]);
  expect(requests).toEqual([
    {
      method: "GET",
      path: `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: ["old-"] }))}`,
    },
  ]);
});

test.each([
  ["missing transport", {}, "ProviderUnavailableError"],
  [
    "HTTP failure",
    { request: () => Effect.succeed({ status: 500, body: "oops" }) },
    "ProviderUnavailableError",
  ],
  ["invalid JSON", { request: () => Effect.succeed({ status: 200, body: "{" }) }, "ProviderInternalError"],
  ["invalid shape", { request: () => Effect.succeed({ status: 200, body: "{}" }) }, "ProviderInternalError"],
] satisfies ReadonlyArray<readonly [string, EngineHttpApi, string]>)(
  "maps %s to a provider error",
  async (_name, api, tag) => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.either(inspectEngineResourceNames(api, { kind: "volume", limit: 64 }, ctx)),
    );
    // Then
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: tag,
      providerId: "test",
      remediation: ctx.remediation,
    });
  },
);
