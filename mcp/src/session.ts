import { resolve } from "node:path";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { CORE_VERSION } from "@lando/engine/version";
import { OperationDiscovery, withAppDiscovery } from "@lando/landofile/operation-discovery";
import { McpToolInputError } from "@lando/sdk/errors";
import type { McpServeOptions } from "@lando/sdk/schema";
import type { Redactor, TieredRedactionValues } from "@lando/sdk/secrets";
import { Context, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore, Stdio } from "effect";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import { stringifyBoundedJson } from "./bounded-json";
import { type McpCallSelectionDeps, type McpCallTarget, selectCallOwner } from "./call-selection";
import type { McpAllowPolicy } from "./catalog";
import { confirmationPrompt } from "./confirmation";
import type { McpDispatchDeps, McpNotify } from "./dispatch";
import { dispatchTool, registerToolInputRedaction } from "./dispatch";
import { type MemoryPressureLevel, attachMemoryPressureListener } from "./memory-pressure";
import type { McpCommandExecutorShape } from "./port";
import { makeStreamFrameSink } from "./progress";
import type { McpCommandEntry, McpToolInput } from "./registry";
import { registerResources } from "./resources";
import type { McpRuntimeConfigShape } from "./service";
import { makeSessionCatalog } from "./session-catalog";
import { withStdioConnection } from "./stdio-connection";
import { DEFAULT_MCP_MAX_CONCURRENT, MAX_OUTSTANDING_REQUESTS, stdioTransportError } from "./stdio-limits";
import { type McpToolNotice, commandResult, rejectionResult } from "./tool-result";

interface McpSession {
  readonly config: McpRuntimeConfigShape;
  readonly options: McpServeOptions;
  /** Session-wide owners (built-ins and, with tooling on, tooling tasks). */
  readonly entries: ReadonlyArray<McpCommandEntry>;
  readonly policy: McpAllowPolicy;
  readonly deps: Omit<McpDispatchDeps, "execute" | "notify" | "select">;
  readonly executor: McpCommandExecutorShape;
  readonly redactor: Redactor;
  readonly bodyRedactor: Redactor;
  readonly payloadValues: () => TieredRedactionValues;
  readonly handleMemoryPressure: (level: MemoryPressureLevel) => void;
}

export const serveSession = Effect.fnUntraced(
  function* (session: McpSession) {
    return yield* withStdioConnection((stdio) =>
      Effect.gen(function* () {
        const sessionCwd = session.options.cwd ?? process.cwd();
        const apps = yield* session.config.apps;
        // Build the session app's generation before the server reads stdin, so the first
        // tools/list already holds its plugin tools. A session app whose plugins fail to build
        // still serves session-wide tools; its calls report the failure and retry the build.
        const startup = yield* Effect.acquireRelease(Scope.make(), (scope, exit) => Scope.close(scope, exit));
        const sessionGeneration = yield* Effect.exit(
          withAppDiscovery(sessionCwd, Scope.provide(apps.acquire(sessionCwd), startup)),
        );
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

        const sessionOwners = new Map(session.entries.map((entry) => [entry.spec.id, entry]));
        const handle = (toolId: string) =>
          Effect.fn("McpService.callTool")(
            function* (input: unknown) {
              let notice: McpToolNotice | undefined;
              const busy = outstanding >= MAX_OUTSTANDING_REQUESTS;
              outstanding++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  outstanding--;
                }),
              );
              // The contracts advertised when the call arrived; a variant published later is not one.
              const advertised = catalog.advertised(toolId);
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
              yield* registerToolInputRedaction(session.deps.registry.get(toolId)?.spec, input);
              const decodedInput = yield* Effect.try({
                try: () => SchemaInput(input),
                catch: () => stdioTransportError("MCP tool arguments must be an object."),
              });
              const appPathInput: unknown = decodedInput.appPath;
              const appPath = typeof appPathInput === "string" ? appPathInput : undefined;
              // A present appPath must name a directory; anything else fails before app selection.
              const appPathRejection =
                appPathInput === undefined || appPath !== undefined
                  ? undefined
                  : new McpToolInputError({
                      toolId,
                      path: "appPath",
                      message: `appPath for tool ${toolId} must be a string directory path.`,
                      remediation:
                        "Pass appPath as an app directory path string, or omit it to use the session directory.",
                    });
              const prompt = yield* confirmationPrompt(
                { toolId, app: appPath ?? sessionCwd },
                session.redactor,
              );
              const output = makeStreamFrameSink(
                notify,
                session.redactor,
                session.payloadValues,
                session.bodyRedactor,
              );
              const target: McpCallTarget = {
                toolId,
                cwd: appPath === undefined ? sessionCwd : resolve(sessionCwd, appPath),
                explicit: appPath !== undefined,
                advertised,
                scope: yield* Effect.scope,
                prompt,
                output,
                published: (appPath, publication) => {
                  notice = { appPath, ...publication };
                },
              };
              const rejection = busy ? stdioTransportError("Server busy") : appPathRejection;
              // One fresh discovery memo per call: acquisition, selection, binding, and execution
              // all resolve the app root through it, and it ends with the call.
              return yield* withAppDiscovery(
                target.cwd,
                Effect.flatMap(OperationDiscovery, (discovery) =>
                  dispatchTool(
                    {
                      toolId,
                      // The rejection reports an invalid appPath; the typed input never carries it.
                      input:
                        appPathRejection === undefined
                          ? decodedInput
                          : Object.fromEntries(
                              Object.entries(decodedInput).filter(([key]) => key !== "appPath"),
                            ),
                    },
                    {
                      ...session.deps,
                      select: () =>
                        selectCallOwner(selection, target).pipe(
                          Effect.provideService(OperationDiscovery, discovery),
                        ),
                      notify,
                      capture: output.capture,
                      ...(rejection === undefined ? {} : { rejection }),
                    },
                  ),
                ),
              ).pipe(
                Effect.flatMap((result) =>
                  commandResult(result, {
                    redactor: session.redactor,
                    ...(notice === undefined ? {} : { notice }),
                  }),
                ),
                Effect.catch((error) =>
                  rejectionResult(error, {
                    toolId,
                    redactor: session.redactor,
                    ...(notice === undefined ? {} : { notice }),
                  }).pipe(Effect.orDie),
                ),
              );
            },
            Effect.catch((error) =>
              rejectionResult(error, { toolId, redactor: session.redactor }).pipe(Effect.orDie),
            ),
            Effect.scoped,
          );
        const catalog = yield* makeSessionCatalog({
          server,
          policy: session.policy,
          entries: session.entries,
          handle,
        });
        const selection: McpCallSelectionDeps = {
          apps,
          catalog,
          policy: session.policy,
          sessionOwners,
          deps: session.deps,
          executor: session.executor,
          permits: semaphore,
        };
        if (Exit.isSuccess(sessionGeneration)) yield* catalog.project(sessionGeneration.value);
        yield* catalog.publishAll;
        yield* Scope.close(startup, Exit.void);

        yield* registerResources(
          session.config.resources ?? [],
          (read) =>
            withAppDiscovery(
              sessionCwd,
              Effect.scoped(
                Effect.flatMap(apps.acquire(sessionCwd), (generation) =>
                  read.pipe(Effect.provide(Context.add(generation.context, RuntimeCwd, sessionCwd))),
                ),
              ),
            ),
          session.deps,
        ).pipe(Effect.provideService(McpServer.McpServer, server));
      }),
    );
  },
  Effect.catchTag("IllegalArgumentError", (error) => Effect.fail(stdioTransportError(error.message))),
);

const SchemaInput = (input: unknown): McpToolInput =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(input ?? {});
