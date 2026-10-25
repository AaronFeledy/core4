import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";
import { Effect, Redacted } from "effect";
import { readAppEnvironment } from "../src/app-environment.ts";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { APP_LABEL, SERVICE_LABEL } from "../src/labels.ts";

const ctx = { providerId: "test", remediation: "Run doctor.", env: {} };
const app = AppId.make("secret-readback");
const labels = { [APP_LABEL]: app, [SERVICE_LABEL]: "web" };
const names = { web: ["API_VALUE", "SECOND"] };

test("reads only requested names from requested services, without requiring secret labels", async () => {
  const requests: string[] = [];
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(`${request.method} ${request.path}`);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify(
          request.path.startsWith("/containers/json?")
            ? [
                { Id: "requested-only", Labels: labels },
                { Id: "ordinary", Labels: { [APP_LABEL]: app, [SERVICE_LABEL]: "other" } },
              ]
            : {
                Config: {
                  Env: [
                    "API_VALUE=a=b=c",
                    "SECOND=second-private",
                    "VISIBLE=visible",
                    "LANDO_HOST_PROXY_TOKEN=bearer-private",
                    "LANDO_HOST_PROXY_SESSION=session-private",
                  ],
                },
              },
        ),
      });
    },
  };
  const values = await Effect.runPromise(readAppEnvironment({ app }, names, { api, ctx }));
  expect(values.every(Redacted.isRedacted)).toBe(true);
  expect(values.map((value) => Redacted.value(value))).toEqual(["a=b=c", "second-private"]);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect(requests.join(" ")).not.toContain("ordinary/json");
});

test("a removed container contributes no values", async () => {
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.succeed(
        request.path.startsWith("/containers/json?")
          ? { status: 200, body: JSON.stringify([{ Id: "gone", Labels: labels }]) }
          : { status: 404, body: "not found" },
      ),
  };
  expect(await Effect.runPromise(readAppEnvironment({ app }, names, { api, ctx }))).toEqual([]);
});

test.each([
  [null, []],
  [["API_VALUE", "SECOND=", "SECOND=kept-private"], ["kept-private"]],
])("a null environment or entries without a value contribute nothing (%#)", async (env, expected) => {
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(
          request.path.startsWith("/containers/json?")
            ? [{ Id: `nullable-${JSON.stringify(env)}`, Labels: labels }]
            : { Config: { Env: env } },
        ),
      }),
  };
  const values = await Effect.runPromise(readAppEnvironment({ app }, names, { api, ctx }));
  expect(values.map((value) => Redacted.value(value))).toEqual(expected);
});

test("an app without containers contributes no values", async () => {
  const api: EngineHttpApi = { request: () => Effect.succeed({ status: 200, body: "[]" }) };
  expect(await Effect.runPromise(readAppEnvironment({ app }, names, { api, ctx }))).toEqual([]);
});

test("ignores containers with omitted or null labels when reading a matching service", async () => {
  // Given: unlabeled containers alongside a requested service.
  const requests: string[] = [];
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(request.path);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify(
          request.path.startsWith("/containers/json?")
            ? [
                { Id: "omitted-labels" },
                { Id: "null-labels", Labels: null },
                { Id: "labeled-service", Labels: labels },
              ]
            : { Config: { Env: ["API_VALUE=matched"] } },
        ),
      });
    },
  };

  // When: reading the requested service environment.
  const values = await Effect.runPromise(readAppEnvironment({ app }, names, { api, ctx }));

  // Then: only the labeled service is inspected and contributes values.
  expect(values.map(Redacted.value)).toEqual(["matched"]);
  expect(requests.filter((path) => !path.startsWith("/containers/json?"))).toEqual([
    "/containers/labeled-service/json",
  ]);
});

test.each([
  "invalid-json-private-canary",
  JSON.stringify({ Config: { Env: [123, "PRIVATE=private-canary"] } }),
])("malformed inspect responses fail without retaining bodies (%#)", async (body) => {
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.succeed({
        status: 200,
        body: request.path.startsWith("/containers/json?")
          ? JSON.stringify([{ Id: "marked", Labels: labels }])
          : body,
      }),
  };
  const result = await Effect.runPromise(Effect.result(readAppEnvironment({ app }, names, { api, ctx })));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderInternalError", operation: "readAppEnvironment" },
  });
  expect(JSON.stringify(result)).not.toContain("private-canary");
});

test("permission failure never includes the engine response body", async () => {
  const api: EngineHttpApi = {
    request: () => Effect.succeed({ status: 403, body: "private-response-canary" }),
  };
  const result = await Effect.runPromise(Effect.result(readAppEnvironment({ app }, names, { api, ctx })));
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  expect(JSON.stringify(result)).not.toContain("private-response-canary");
});

test("lists every call, caches immutable Ids across callers and requested names, and prunes removed Ids", async () => {
  const requests: string[] = [];
  let ids = ["cache-first"];
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        requests.push(request.path);
        return {
          status: 200,
          body: JSON.stringify(
            request.path.startsWith("/containers/json?")
              ? ids.map((Id) => ({ Id, Labels: labels }))
              : { Config: { Env: ["API_VALUE=first", "SECOND=second"] } },
          ),
        };
      }),
  };
  const read = (requested = names) => Effect.runPromise(readAppEnvironment({ app }, requested, { api, ctx }));
  await read();
  const second = await read({ web: ["SECOND"] });
  expect(second.map(Redacted.value)).toEqual(["second"]);
  expect(requests.filter((path) => !path.startsWith("/containers/json?"))).toHaveLength(1);
  ids = ["cache-next"];
  await read();
  ids = ["cache-first"];
  await read();
  expect(requests.filter((path) => path.startsWith("/containers/json?"))).toHaveLength(4);
  expect(requests.filter((path) => !path.startsWith("/containers/json?"))).toEqual([
    "/containers/cache-first/json",
    "/containers/cache-next/json",
    "/containers/cache-first/json",
  ]);
});

test("transport failures discard their cause and response data", async () => {
  const api: EngineHttpApi = {
    request: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "test",
          operation: "request",
          message: "transport-private-canary",
        }),
      ),
  };
  const result = await Effect.runPromise(Effect.result(readAppEnvironment({ app }, names, { api, ctx })));
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  expect(JSON.stringify(result)).not.toContain("transport-private-canary");
});
