import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { CORE_VERSION } from "@lando/engine/version";
import { buildCommandResultEnvelope } from "@lando/sdk/command-result";
import { McpToolInputError, McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import type { McpCatalog, McpServeOptions } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  type Scope,
  Semaphore,
  Stdio,
} from "effect";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import { computeMcpDefaultAllowlist } from "./allowlist";
import {
  APP_COMMAND_CALL_ID,
  APP_COMMAND_INPUT_SCHEMAS,
  APP_COMMAND_LIST_ID,
  APP_COMMAND_TOOL_IDS,
  decodeAppCommandCallInput,
  decodeAppCommandListInput,
} from "./app-command-tools";
import { stringifyBoundedJson } from "./bounded-json";
import { redactBoundedJsonValue } from "./bounded-json";
import { buildCatalog, computeEffectiveAllowlist } from "./catalog";
import { confirmationPrompt } from "./confirmation";
import type { McpDispatchDeps, McpDispatchError, McpNotify } from "./dispatch";
import { dispatchTool } from "./dispatch";
import { makeNestedExecute } from "./execute";
import { type MemoryPressureLevel, attachMemoryPressureListener } from "./memory-pressure";
import type { McpCommandExecutorShape } from "./port";
import { makeStreamFrameSink } from "./progress";
import type { McpToolInput } from "./registry";
import { registerResources } from "./resources";
import type { McpRuntimeConfigShape } from "./service";
import { withStdioConnection } from "./stdio-connection";
import { DEFAULT_MCP_MAX_CONCURRENT, MAX_OUTSTANDING_REQUESTS, stdioTransportError } from "./stdio-limits";
import { commandResult, rejectionResult, toolOutputSchema } from "./tool-result";

interface McpSession {
  readonly config: McpRuntimeConfigShape;
  readonly catalog: McpCatalog;
  readonly options: McpServeOptions;
  readonly deps: Omit<McpDispatchDeps, "execute" | "notify">;
  readonly executor: McpCommandExecutorShape;
  readonly redactor: Redactor;
  readonly payloadValues: () => Iterable<string>;
  readonly handleMemoryPressure: (level: MemoryPressureLevel) => void;
}

const mcpRejection = (error: unknown): McpDispatchError =>
  error instanceof McpToolInputError ||
  error instanceof McpToolNotAllowedError ||
  error instanceof McpTransportError
    ? error
    : new McpTransportError({
        message: "Could not resolve the selected app plugin commands.",
        cause: error,
        remediation: "Check the app path and installed plugins, then retry the call.",
      });

export const serveSession = Effect.fnUntraced(
  function* (session: McpSession) {
    return yield* withStdioConnection((stdio) =>
      Effect.gen(function* () {
        const runtime = Context.makeUnsafe<unknown>(
          (yield* Layer.build(session.config.runtimeLayer)).mapUnsafe,
        );
        const runtimeContext =
          session.options.cwd === undefined ? runtime : Context.add(runtime, RuntimeCwd, session.options.cwd);
        const semaphore = yield* Semaphore.make(session.options.maxConcurrent ?? DEFAULT_MCP_MAX_CONCURRENT);
        let outstanding = 0;
        const detach = attachMemoryPressureListener(session.handleMemoryPressure);
        yield* Effect.addFinalizer(() => Effect.sync(detach));
        const context = yield* Layer.build(
          McpServer.layerStdio({
            name: "lando",
            version: session.config.version ?? CORE_VERSION,
            protocols: [McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05],
          }).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, stdio))),
        ).pipe(Effect.forkScoped, Effect.flatMap(Fiber.join));
        const server = Context.get(context, McpServer.McpServer);
        for (const descriptor of session.catalog.tools) {
          const entry = session.deps.registry.get(descriptor.toolId);
          if (entry === undefined) continue;
          const handle = Effect.fn("McpService.callTool")(
            function* (input: unknown) {
              const busy = outstanding >= MAX_OUTSTANDING_REQUESTS;
              outstanding++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  outstanding--;
                }),
              );
              const request = yield* McpSchema.McpRequestContext;
              let progress = 0;
              const notify: McpNotify = Effect.fnUntraced(function* (frame) {
                const token = request.requestMetadata?.progressToken;
                if (typeof token !== "string" && typeof token !== "number") return;
                const message = yield* stringifyBoundedJson(frame, "MCP progress payload");
                yield* server.notifications["notifications/progress"]({
                  progressToken: token,
                  progress: ++progress,
                  message,
                });
              });
              const decodedInput = yield* Effect.try({
                try: () => SchemaInput(input),
                catch: () => stdioTransportError("MCP tool arguments must be an object."),
              });
              const cwd =
                typeof decodedInput.appPath === "string"
                  ? decodedInput.appPath
                  : Option.getOrElse(Context.getOption(runtimeContext, RuntimeCwd), () => process.cwd());
              if (busy)
                return yield* dispatchTool(
                  { toolId: descriptor.toolId, input: decodedInput },
                  {
                    ...session.deps,
                    execute: () => Effect.die(new Error("Rejected before execution")),
                    rejection: stdioTransportError("Server busy"),
                    notify,
                  },
                ).pipe(Effect.flatMap(commandResult));
              return yield* semaphore.withPermits(1)(
                Effect.gen(function* () {
                  const appContext =
                    session.config.appContextForCwd === undefined
                      ? runtimeContext
                      : yield* session.config.appContextForCwd(runtimeContext, cwd);
                  const prompt = yield* confirmationPrompt(
                    {
                      toolId: descriptor.toolId,
                      app: cwd,
                    },
                    session.redactor,
                  );
                  const callContext = Option.isSome(prompt)
                    ? Context.add(appContext, ConfirmationPrompt, prompt.value)
                    : appContext;
                  const output = makeStreamFrameSink(notify, session.redactor, session.payloadValues);
                  const nested = makeNestedExecute(callContext, output, session.executor);
                  const execute: McpDispatchDeps["execute"] = nested;
                  return yield* dispatchTool(
                    { toolId: descriptor.toolId, input: decodedInput },
                    {
                      ...session.deps,
                      execute,
                      notify,
                      capture: output.capture,
                    },
                  ).pipe(Effect.flatMap(commandResult));
                }),
              );
            },
            Effect.catch((error) =>
              rejectionResult(mcpRejection(error), session.redactor).pipe(Effect.orDie),
            ),
            Effect.scoped,
          );
          yield* server.addTool({
            tool: new McpSchema.Tool({
              name: descriptor.toolId,
              title: descriptor.title,
              description: descriptor.description,
              inputSchema: SchemaToolInput(descriptor.inputSchema),
              outputSchema: toolOutputSchema(entry.spec.resultSchema),
            }),
            annotations: Context.empty(),
            handle,
          });
        }
        if (session.config.appCommandEntries !== undefined && session.config.appContextForCwd !== undefined) {
          const resolveAppContext = session.config.appContextForCwd;
          const loadAppEntries = session.config.appCommandEntries;
          const selectedApp = Effect.fnUntraced(function* (appPath: string) {
            const appContext = yield* resolveAppContext(runtimeContext, appPath);
            const entries = (yield* loadAppEntries(appContext)).filter(
              (entry) =>
                !session.deps.registry.has(entry.spec.id) &&
                !APP_COMMAND_TOOL_IDS.includes(entry.spec.id as (typeof APP_COMMAND_TOOL_IDS)[number]),
            );
            const defaults = yield* Effect.try({
              try: () => computeMcpDefaultAllowlist(entries.map((entry) => entry.spec)),
              catch: () =>
                new McpToolInputError({
                  message: "The selected app declares an MCP-unsafe plugin command as allowed by default.",
                  toolId: APP_COMMAND_CALL_ID,
                  remediation: "Remove mcpAllowed from destructive plugin commands in this app.",
                }),
            });
            const effective = computeEffectiveAllowlist({
              defaults,
              allow: session.options.allow?.filter(
                (id) => !APP_COMMAND_TOOL_IDS.includes(id as (typeof APP_COMMAND_TOOL_IDS)[number]),
              ),
              deny: session.options.deny,
            });
            return { appContext, entries, effective };
          });
          const appTool = (
            name: string,
            description: string,
            inputSchema: Record<string, unknown>,
            handle: (
              input: unknown,
            ) => Effect.Effect<McpSchema.CallToolResult, unknown, Scope.Scope | McpSchema.McpRequestContext>,
          ) =>
            server.addTool({
              tool: new McpSchema.Tool({
                name,
                title: name,
                description,
                inputSchema: SchemaToolInput(inputSchema),
                outputSchema: toolOutputSchema(Schema.Unknown),
              }),
              annotations: Context.empty(),
              handle: (input) =>
                Effect.gen(function* () {
                  const busy = outstanding >= MAX_OUTSTANDING_REQUESTS;
                  outstanding++;
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      outstanding--;
                    }),
                  );
                  if (busy) return yield* Effect.fail(stdioTransportError("Server busy"));
                  return yield* handle(input);
                }).pipe(
                  Effect.scoped,
                  Effect.catch((error) =>
                    rejectionResult(mcpRejection(error), session.redactor).pipe(Effect.orDie),
                  ),
                ),
            });
          if (session.catalog.tools.some((tool) => tool.toolId === APP_COMMAND_LIST_ID))
            yield* appTool(
              APP_COMMAND_LIST_ID,
              "List MCP-allowed plugin commands for the selected app.",
              APP_COMMAND_INPUT_SCHEMAS[APP_COMMAND_LIST_ID],
              (input) =>
                Effect.gen(function* () {
                  const fields = yield* decodeAppCommandListInput(input);
                  const appPath = fields.appPath;
                  if (typeof appPath !== "string")
                    return yield* Effect.fail(stdioTransportError("appPath is required."));
                  return yield* semaphore.withPermits(1)(
                    Effect.gen(function* () {
                      const selected = yield* selectedApp(appPath);
                      const catalog = buildCatalog({
                        commandEntries: selected.entries,
                        effective: selected.effective,
                      });
                      const envelope = yield* buildCommandResultEnvelope({
                        command: APP_COMMAND_LIST_ID,
                        resultSchema: Schema.Unknown,
                        outcome: { _tag: "success", value: catalog },
                        redactor: session.redactor,
                      });
                      const safe = yield* redactBoundedJsonValue(
                        envelope,
                        session.redactor,
                        "MCP app command catalog",
                      );
                      if (!Predicate.isObject(safe))
                        return yield* Effect.fail(
                          stdioTransportError("MCP app command catalog was not an object."),
                        );
                      return yield* commandResult({ envelope: safe, ok: true });
                    }),
                  );
                }),
            );
          if (session.catalog.tools.some((tool) => tool.toolId === APP_COMMAND_CALL_ID))
            yield* appTool(
              APP_COMMAND_CALL_ID,
              "Call an MCP-allowed plugin command in the selected app.",
              APP_COMMAND_INPUT_SCHEMAS[APP_COMMAND_CALL_ID],
              (input) =>
                Effect.gen(function* () {
                  const fields = yield* decodeAppCommandCallInput(input);
                  const appPath = fields.appPath;
                  const commandId = fields.commandId;
                  if (typeof appPath !== "string" || typeof commandId !== "string") {
                    return yield* Effect.fail(stdioTransportError("appPath and commandId are required."));
                  }
                  return yield* semaphore.withPermits(1)(
                    Effect.gen(function* () {
                      const selected = yield* selectedApp(appPath);
                      const request = yield* McpSchema.McpRequestContext;
                      let progress = 0;
                      const notify: McpNotify = Effect.fnUntraced(function* (frame) {
                        const token = request.requestMetadata?.progressToken;
                        if (typeof token !== "string" && typeof token !== "number") return;
                        const message = yield* stringifyBoundedJson(frame, "MCP progress payload");
                        yield* server.notifications["notifications/progress"]({
                          progressToken: token,
                          progress: ++progress,
                          message,
                        });
                      });
                      const prompt = yield* confirmationPrompt(
                        { toolId: commandId, app: appPath },
                        session.redactor,
                      );
                      const callContext = Option.isSome(prompt)
                        ? Context.add(selected.appContext, ConfirmationPrompt, prompt.value)
                        : selected.appContext;
                      const output = makeStreamFrameSink(notify, session.redactor, session.payloadValues);
                      const execute = makeNestedExecute(callContext, output, session.executor);
                      const result = yield* dispatchTool(
                        {
                          toolId: commandId,
                          input: {
                            appPath,
                            ...(fields.flags === undefined
                              ? {}
                              : { flags: fields.flags as Record<string, unknown> }),
                            ...(fields.args === undefined
                              ? {}
                              : { args: fields.args as Record<string, unknown> }),
                          },
                        },
                        {
                          ...session.deps,
                          registry: new Map(selected.entries.map((entry) => [entry.spec.id, entry])),
                          effective: selected.effective.ids,
                          allowlistSource: selected.effective.source,
                          execute,
                          notify,
                          capture: output.capture,
                        },
                      );
                      return yield* commandResult(result);
                    }),
                  );
                }),
            );
        }
        yield* registerResources(session.config.resources ?? [], runtimeContext, session.deps).pipe(
          Effect.provideService(McpServer.McpServer, server),
        );
      }),
    );
  },
  Effect.catchTag("IllegalArgumentError", (error) => Effect.fail(stdioTransportError(error.message))),
);

const SchemaInput = (input: unknown): McpToolInput =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(input ?? {});
const SchemaToolInput = Schema.decodeUnknownSync(McpSchema.ToolJson);
