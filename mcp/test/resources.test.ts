import { expect, test } from "bun:test";
import { McpTransportError } from "@lando/sdk/errors";
import { JSON_SCHEMA_NAMES, getJsonSchema } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { serverLayer, startServer } from "./server";

const uris = ["lando://app/config", "lando://app/info", "lando://apps", "lando://doctor"] as const;
const secret = "resource-planted-secret";
const resources = uris.map((uri) => ({
  uri,
  name: uri,
  description: uri,
  resultSchema: Schema.Struct({ uri: Schema.String, value: Schema.String }),
  read: Effect.succeed({ uri, value: secret }),
}));
const layer = serverLayer({ resources }, [secret]);

test("lists resources and the public schema template", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return {
          list: yield* client.request("resources/list"),
          templates: yield* client.request("resources/templates/list"),
        };
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(observed.list).toMatchObject({
    result: { resources: uris.map((uri) => ({ uri, mimeType: "application/json" })) },
  });
  expect(observed.templates).toMatchObject({
    result: { resourceTemplates: [{ uriTemplate: "lando://schemas/{name}", mimeType: "application/json" }] },
  });
});

test.each([...uris])("reads schema-encoded, bounded, secret-redacted resource %s", async (uri) => {
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("resources/read", { uri });
      }),
    ).pipe(Effect.provide(layer)),
  );
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      contents: Schema.Array(
        Schema.Struct({ uri: Schema.String, mimeType: Schema.String, text: Schema.String }),
      ),
    }),
  )(response.result);
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0]).toMatchObject({ uri, mimeType: "application/json" });
  expect(JSON.parse(result.contents[0]?.text ?? "null")).toEqual({ uri, value: "[redacted]" });
  expect(JSON.stringify(response)).not.toContain(secret);
});

test("schema resources read the public registry, complete names, and reject unknown names", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return {
          schema: yield* client.request("resources/read", { uri: "lando://schemas/CommandResultEnvelope" }),
          unknown: yield* client.request("resources/read", { uri: "lando://schemas/not-a-schema" }),
          complete: yield* client.request("completion/complete", {
            ref: { type: "ref/resource", uri: "lando://schemas/{name}" },
            argument: { name: "name", value: "CommandResult" },
          }),
        };
      }),
    ).pipe(Effect.provide(layer)),
  );
  const encoded = Schema.decodeUnknownSync(
    Schema.Struct({ contents: Schema.Array(Schema.Struct({ text: Schema.String })) }),
  )(observed.schema.result);
  expect(JSON.parse(encoded.contents[0]?.text ?? "null")).toEqual(getJsonSchema("CommandResultEnvelope"));
  expect(observed.unknown).toMatchObject({
    error: { code: -32602, message: "Unknown Lando JSON schema name." },
  });
  expect(observed.complete).toMatchObject({
    result: {
      completion: {
        values: JSON_SCHEMA_NAMES.filter((name) => name.startsWith("CommandResult")),
        hasMore: false,
      },
    },
  });
});

test("resource failures preserve redacted tagged error data", async () => {
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("resources/read", { uri: "lando://doctor" });
      }),
    ).pipe(
      Effect.provide(
        serverLayer(
          {
            resources: [
              {
                uri: "lando://doctor",
                name: "Doctor",
                description: "Doctor",
                resultSchema: Schema.Unknown,
                read: Effect.fail(
                  new McpTransportError({ message: `Failure ${secret}`, remediation: `Retry ${secret}` }),
                ),
              },
            ],
          },
          [secret],
        ),
      ),
    ),
  );
  expect(response).toMatchObject({
    error: {
      code: -32603,
      message: "Failure [redacted]",
      data: { _tag: "McpTransportError", message: "Failure [redacted]", remediation: "Retry [redacted]" },
    },
  });
});
