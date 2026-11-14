import { JSON_SCHEMA_NAMES, getJsonSchema } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Context, Effect, Predicate, Schema } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import { McpServer } from "effect/ai/McpServer";
import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import { McpDiagnostics } from "./diagnostics";
import type { McpDispatchDeps } from "./dispatch";

export interface McpResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly resultSchema: Schema.Codec<unknown, unknown>;
  readonly read: Effect.Effect<unknown, unknown, unknown>;
  readonly redactionTokens?: (value: unknown) => ReadonlyArray<string>;
}

const resourceError = Effect.fnUntraced(function* (error: unknown, redactor: Redactor) {
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

/** Runs one resource read with the services of the app the session serves. */
type McpResourceProvider = <A, E>(read: Effect.Effect<A, E, unknown>) => Effect.Effect<A, unknown, never>;

const registerResourceEntries = Effect.fn("McpService.registerResourceEntries")(function* (
  entries: ReadonlyArray<McpResourceEntry>,
  provide: McpResourceProvider,
  redaction: Pick<McpDispatchDeps, "redactor" | "resultRedactor">,
) {
  const server = yield* McpServer;
  const { redactor, resultRedactor } = redaction;
  for (const entry of entries) {
    const readResource = Effect.fn("McpService.readResource")(
      function* () {
        const value = yield* provide(entry.read);
        const encoded = yield* Schema.encodeUnknownEffect(entry.resultSchema)(value);
        return yield* contents(
          entry.uri,
          encoded,
          yield* resultRedactor(entry.redactionTokens?.(value) ?? []),
        );
      },
      Effect.scoped,
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
});

export const registerDiagnosticsResource = Effect.fnUntraced(function* (
  read: Effect.Effect<McpDiagnostics, unknown>,
  redaction: Pick<McpDispatchDeps, "redactor" | "resultRedactor">,
) {
  const context = Context.makeUnsafe<unknown>((yield* Effect.context<never>()).mapUnsafe);
  yield* registerResourceEntries(
    [
      {
        uri: "lando://diagnostics",
        name: "Command availability diagnostics",
        description:
          "Unavailable authorized commands for the session directory app. Reading refreshes the shared tool catalog; fix the reported source and read again to recover without reconnecting.",
        resultSchema: McpDiagnostics,
        read,
      },
    ],
    (effect) => Effect.provide(effect, context),
    redaction,
  );
});

export const registerResources = Effect.fn("McpService.registerResources")(function* (
  entries: ReadonlyArray<McpResourceEntry>,
  provide: McpResourceProvider,
  redaction: Pick<McpDispatchDeps, "redactor" | "resultRedactor">,
) {
  yield* registerResourceEntries(entries, provide, redaction);
  const server = yield* McpServer;
  const { redactor } = redaction;
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
