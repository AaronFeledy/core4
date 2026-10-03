import { JSON_SCHEMA_NAMES, getJsonSchema } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Context, Effect, Predicate, Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { McpServer } from "effect/ai/McpServer";
import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import { withResultTokens } from "./dispatch";

export interface McpResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  readonly read: Effect.Effect<unknown, unknown, unknown>;
  readonly redactionTokens?: (value: unknown) => ReadonlyArray<string>;
}

export const resourceError = Effect.fnUntraced(function* (error: unknown, redactor: Redactor) {
  const data = {
    _tag:
      Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
        ? error._tag
        : "McpTransportError",
    message:
      Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
        ? error.message
        : "MCP resource read failed.",
    remediation:
      Predicate.hasProperty(error, "remediation") && Predicate.isString(error.remediation)
        ? error.remediation
        : "Check the resource and retry.",
  };
  const bounded = yield* redactBoundedJsonValue(data, redactor, "MCP resource failure").pipe(Effect.orDie);
  return new McpSchema.InternalError({ message: redactor.redactString(data.message), data: bounded });
});

const contents = Effect.fnUntraced(function* (uri: string, value: unknown, redactor: Redactor) {
  const text = yield* stringifyBoundedJson(value, "MCP resource payload", redactor);
  return McpSchema.ReadResourceResult.make({ contents: [{ uri, mimeType: "application/json", text }] });
});

export const registerResources = Effect.fn("McpService.registerResources")(function* (
  entries: ReadonlyArray<McpResourceEntry>,
  context: Context.Context<unknown>,
  redactor: Redactor,
) {
  const server = yield* McpServer;
  for (const entry of entries) {
    const readResource = Effect.fn("McpService.readResource")(
      function* () {
        const value = yield* entry.read;
        const encoded = yield* Schema.encodeUnknownEffect(entry.resultSchema)(value);
        return yield* contents(
          entry.uri,
          encoded,
          withResultTokens(redactor, entry.redactionTokens?.(value) ?? []),
        );
      },
      Effect.scoped,
      Effect.provide(context),
      Effect.catch((error) => resourceError(error, redactor).pipe(Effect.flatMap(Effect.fail))),
    );
    yield* server.addResource({
      resource: new McpSchema.Resource({
        uri: entry.uri,
        name: entry.name,
        description: entry.description,
        mimeType: "application/json",
      }),
      annotations: Context.empty(),
      handle: readResource(),
    });
  }
  yield* server.addResourceTemplate({
    template: new McpSchema.ResourceTemplate({
      uriTemplate: "lando://schemas/{name}",
      name: "Lando JSON schemas",
      mimeType: "application/json",
    }),
    annotations: Context.empty(),
    routerPath: "lando:://schemas/:0",
    completions: {
      name: (input) =>
        Effect.succeed(
          McpSchema.CompleteResult.make({
            completion: {
              values: JSON_SCHEMA_NAMES.filter((name) => name.startsWith(input)).slice(0, 100),
              total: JSON_SCHEMA_NAMES.filter((name) => name.startsWith(input)).length,
              hasMore: JSON_SCHEMA_NAMES.filter((name) => name.startsWith(input)).length > 100,
            },
          }),
        ),
    },
    handle: Effect.fn("McpService.readResource")(
      function* (uri: string, params: Array<string>) {
        const name = JSON_SCHEMA_NAMES.find((candidate) => candidate === params[0]);
        if (name === undefined)
          return yield* new McpSchema.InvalidParams({ message: "Unknown Lando JSON schema name." });
        return yield* contents(uri, getJsonSchema(name), redactor);
      },
      Effect.catchTag("McpTransportError", (error) =>
        resourceError(error, redactor).pipe(Effect.flatMap(Effect.fail)),
      ),
    ),
  });
});
