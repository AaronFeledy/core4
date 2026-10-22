import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect, Redacted } from "effect";
import { readAppSecrets } from "../src/app-secrets.ts";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { APP_LABEL, HOST_PROXY_SESSION_LABEL, SECRET_ENVIRONMENT_LABEL } from "../src/labels.ts";

const ctx = { providerId: "test", remediation: "Run doctor." };
const app = AppId.make("secret-readback");
const labels = { [APP_LABEL]: app, [SECRET_ENVIRONMENT_LABEL]: "API_VALUE,SECOND" };

test("reads only marked override values and transport credentials from existing containers", async () => {
  const requests: string[] = [];
  const api: EngineHttpApi = {
    request: (request) => {
      requests.push(`${request.method} ${request.path}`);
      return Effect.succeed({
        status: 200,
        body: JSON.stringify(
          request.path.startsWith("/containers/json?")
            ? [
                { Id: "marked", Labels: labels },
                { Id: "ordinary", Labels: { [APP_LABEL]: app } },
                { Id: "proxy", Labels: { [APP_LABEL]: app, [HOST_PROXY_SESSION_LABEL]: "session" } },
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
  const values = await Effect.runPromise(readAppSecrets({ app }, { api, ctx }));
  expect(values.every(Redacted.isRedacted)).toBe(true);
  expect(values.map((value) => Redacted.value(value))).toEqual([
    "a=b=c",
    "second-private",
    "bearer-private",
    "session-private",
  ]);
  expect(requests).toHaveLength(3);
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
  expect(await Effect.runPromise(readAppSecrets({ app }, { api, ctx }))).toEqual([]);
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
            ? [{ Id: "marked", Labels: labels }]
            : { Config: { Env: env } },
        ),
      }),
  };
  const values = await Effect.runPromise(readAppSecrets({ app }, { api, ctx }));
  expect(values.map((value) => Redacted.value(value))).toEqual(expected);
});

test("an app without containers contributes no values", async () => {
  const api: EngineHttpApi = { request: () => Effect.succeed({ status: 200, body: "[]" }) };
  expect(await Effect.runPromise(readAppSecrets({ app }, { api, ctx }))).toEqual([]);
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
  const result = await Effect.runPromise(Effect.result(readAppSecrets({ app }, { api, ctx })));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProviderInternalError", operation: "readAppSecrets" },
  });
  expect(JSON.stringify(result)).not.toContain("private-canary");
});

test("permission failure never includes the engine response body", async () => {
  const api: EngineHttpApi = {
    request: () => Effect.succeed({ status: 403, body: "private-response-canary" }),
  };
  const result = await Effect.runPromise(Effect.result(readAppSecrets({ app }, { api, ctx })));
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  expect(JSON.stringify(result)).not.toContain("private-response-canary");
});
