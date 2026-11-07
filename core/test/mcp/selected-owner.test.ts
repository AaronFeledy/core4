import { expect, test } from "bun:test";

import type { McpAppGeneration, McpGenerationCommand } from "@lando/mcp/apps";
import type { McpCommandEntry } from "@lando/mcp/registry";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import { PluginLoadError } from "@lando/sdk/errors";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

import { serviceLayer } from "../../src/mcp-command-executor";

type Owner = "bundled" | "external";

const ResultSchema = Schema.Struct({ app: Schema.String, id: Schema.String });

const owner = (
  app: string,
  id: string,
  options: {
    readonly source?: Owner;
    readonly flags?: Record<string, unknown>;
    readonly runs?: string[];
  } = {},
): McpGenerationCommand => {
  const source = options.source ?? "external";
  const entry: McpCommandEntry = {
    spec: {
      id,
      summary: `Fixture ${id}`,
      mcpAllowed: true,
      flags: options.flags ?? {},
      resultSchema: ResultSchema,
      run: () =>
        Effect.sync(() => {
          options.runs?.push(app);
          return { app, id };
        }),
    },
    plugin: { name: `@example/app-${app}`, source, provenance: source === "bundled" ? "bundled" : "app" },
  };
  return { _tag: "Eligible", entry };
};

const generation = (key: string, commands: ReadonlyArray<McpGenerationCommand>): McpAppGeneration => ({
  key,
  context: Context.makeUnsafe<unknown>(new Map()),
  commands: new Map(
    commands.map((command) => [
      command._tag === "Eligible" ? command.entry.spec.id : command.commandId,
      command,
    ]),
  ),
});

/** Serve a session from /apps/a with one generation per app directory, then run `use`. */
const session = <A>(
  apps: ReadonlyArray<McpAppGeneration>,
  options: {
    readonly allow?: ReadonlyArray<string>;
    readonly deny?: ReadonlyArray<string>;
    readonly defaults?: ReadonlyArray<string>;
  },
  use: (client: Effect.Success<ReturnType<typeof startStdioClient>>) => Effect.Effect<A, unknown, McpService>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(
          service.serve({
            transport: "stdio",
            cwd: "/apps/a",
            ...(options.allow === undefined ? {} : { allow: options.allow }),
            ...(options.deny === undefined ? {} : { deny: options.deny }),
          }),
        );
        return yield* use(client);
      }),
    ).pipe(
      Effect.provide(
        serviceLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(McpRuntimeConfig, {
                commandEntries: [],
                defaultAllowlist: options.defaults ?? [],
                apps: Effect.succeed({
                  acquire: (cwd: string) => {
                    const found = apps.find((app) => app.key === cwd);
                    return found === undefined
                      ? Effect.fail({ _tag: "FixtureAppMissing", message: `No fixture app at ${cwd}.` })
                      : Effect.succeed(found);
                  },
                }),
              }),
              RedactionService.layer,
            ),
          ),
        ),
      ),
    ),
  );

const toolNames = (list: Schema.JsonObject) => {
  const result = list.result;
  const tools = Predicate.isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  return tools.flatMap((tool) =>
    Predicate.isObject(tool) && typeof tool.name === "string" ? [tool.name] : [],
  );
};

const toolNamed = (list: Schema.JsonObject, name: string) => {
  const result = list.result;
  const tools = Predicate.isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  return tools.find((tool) => Predicate.isObject(tool) && tool.name === name);
};

/** The structured envelope of a tools/call response. */
const outcome = (response: Schema.JsonObject): unknown => {
  const result = response.result;
  if (!Predicate.isObject(result)) return response.error;
  return result.structuredContent;
};

test("a tool the selected app does not define is rejected on appPath without reconnect advice", async () => {
  // Given a session app defining fixture:a-only and another app that does not
  const runs: string[] = [];
  const apps = [generation("/apps/a", [owner("a", "fixture:a-only", { runs })]), generation("/apps/b", [])];

  // When fixture:a-only is called for the other app
  const rejected = await session(apps, { allow: ["fixture:a-only"] }, (client) =>
    client.request("tools/call", { name: "fixture:a-only", arguments: { appPath: "../b" } }),
  );

  // Then the call fails on appPath, naming the selected app, without running any owner
  expect(outcome(rejected)).toMatchObject({
    ok: false,
    error: { _tag: "McpToolInputError", path: "appPath", message: expect.stringContaining("/apps/b") },
  });
  expect(JSON.stringify(outcome(rejected))).not.toContain("Reconnect");
  expect(runs).toEqual([]);
});

test("a pending allowance becomes a native tool once a call discovers its app, announced by list_changed", async () => {
  // Given fixture:b-only allowed but defined only by an app the session has not visited
  const runs: string[] = [];
  const apps = [
    generation("/apps/a", [owner("a", "fixture:a-only")]),
    generation("/apps/b", [owner("b", "fixture:b-only", { runs })]),
  ];

  const observed = await session(apps, { allow: ["fixture:a-only", "fixture:b-only"] }, (client) =>
    Effect.gen(function* () {
      const takeUntil = (predicate: (message: Schema.JsonObject) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const message = yield* client.next;
            if (predicate(message)) return message;
          }
        }).pipe(Effect.timeout("5 seconds"));
      const listing = yield* client.sendRequest("tools/list");
      const before = yield* listing.response;
      // Everything up to this listing predates the trigger.
      yield* takeUntil((message) => message.id === listing.id);
      // When any call targets that app
      const { id, response } = yield* client.sendRequest("tools/call", {
        name: "fixture:a-only",
        arguments: { appPath: "/apps/b" },
      });
      // The announcement and the call's reply may arrive in either order.
      let changed: Schema.JsonObject | undefined;
      let replied = false;
      yield* takeUntil((message) => {
        if (message.method === "notifications/tools/list_changed") changed = message;
        if (message.id === id) replied = true;
        return changed !== undefined && replied;
      });
      const after = yield* client.request("tools/list");
      const call = yield* client.request("tools/call", {
        name: "fixture:b-only",
        arguments: { appPath: "/apps/b" },
      });
      return { before, changed, after, call, trigger: yield* response };
    }),
  );

  // Then the tool is listed after the announcement and runs with that app's owner
  expect(toolNames(observed.before)).toEqual(["fixture:a-only"]);
  expect(observed.changed?.method).toBe("notifications/tools/list_changed");
  expect(toolNames(observed.after).sort()).toEqual(["fixture:a-only", "fixture:b-only"]);
  expect(outcome(observed.call)).toMatchObject({ ok: true, result: { app: "b", id: "fixture:b-only" } });
  const trigger = Schema.decodeUnknownSync(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
      structuredContent: Schema.JsonObject,
    }),
  )(observed.trigger.result);
  expect(trigger.content).toHaveLength(2);
  expect(JSON.parse(trigger.content[0]?.text ?? "null")).toEqual(trigger.structuredContent);
  expect(trigger.structuredContent).toMatchObject({ ok: false, error: { _tag: "McpToolInputError" } });
  expect(trigger.content[1]?.text).toContain("/apps/b");
  expect(trigger.content[1]?.text).toContain("fixture:b-only");
  expect(runs).toEqual(["b"]);
});

test("one id defined differently by two apps publishes a union, validates by target, and asks for a re-list first", async () => {
  // Given two apps whose owners of fixture:shared take different flags
  const runs: string[] = [];
  const apps = [
    generation("/apps/a", [owner("a", "fixture:shared", { flags: { alpha: { type: "string" } }, runs })]),
    generation("/apps/b", [owner("b", "fixture:shared", { flags: { beta: { type: "boolean" } }, runs })]),
  ];

  const observed = await session(apps, { allow: ["fixture:shared"] }, (client) =>
    Effect.gen(function* () {
      const call = (args: Schema.JsonObject) =>
        client.request("tools/call", { name: "fixture:shared", arguments: args });
      // When B's variant is called before the client re-lists, then after
      const unadvertised = yield* call({ appPath: "/apps/b", flags: { beta: true } });
      const listed = yield* client.request("tools/list");
      return {
        unadvertised,
        listed,
        targetB: yield* call({ appPath: "/apps/b", flags: { beta: true } }),
        foreignFlag: yield* call({ appPath: "/apps/b", flags: { alpha: "x" } }),
        targetA: yield* call({ flags: { alpha: "x" } }),
      };
    }),
  );

  // Then the first call asks for a re-list without running, and the union admits both variants
  expect(outcome(observed.unadvertised)).toMatchObject({
    ok: false,
    error: { _tag: "McpToolInputError", remediation: expect.stringContaining("tools/list") },
  });
  const content = Schema.decodeUnknownSync(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ text: Schema.String })),
    }),
  )(observed.unadvertised.result).content;
  expect(content).toHaveLength(2);
  expect(content[1]?.text).toContain("/apps/b");
  expect(content[1]?.text).toContain("fixture:shared");
  expect(
    Schema.decodeUnknownSync(
      Schema.Struct({
        content: Schema.Array(Schema.Unknown),
      }),
    )(observed.targetB.result).content,
  ).toHaveLength(1);
  const schema = toolNamed(observed.listed, "fixture:shared");
  expect(schema).toMatchObject({
    inputSchema: { type: "object", anyOf: [expect.anything(), expect.anything()] },
  });
  expect(JSON.stringify(schema)).toContain("app /apps/b");
  // The selected owner stays authoritative for validation and execution
  expect(outcome(observed.targetB)).toMatchObject({ ok: true, result: { app: "b" } });
  expect(outcome(observed.foreignFlag)).toMatchObject({
    error: { _tag: "McpToolInputError", path: "flags.alpha" },
  });
  expect(outcome(observed.targetA)).toMatchObject({ ok: true, result: { app: "a" } });
  expect(runs).toEqual(["b", "a"]);
});

test("a selected owner that failed to load keeps its tagged error and never falls back to another owner", async () => {
  // Given the session app's working owner and another app whose owner failed to load
  const runs: string[] = [];
  const failure = new PluginLoadError({
    pluginName: "@example/app-b",
    message: "Plugin command fixture:shared failed to load.",
    remediation: "Repair the plugin command module.",
  });
  const apps = [
    generation("/apps/a", [owner("a", "fixture:shared", { runs })]),
    generation("/apps/b", [{ _tag: "Failed", commandId: "fixture:shared", error: failure }]),
  ];

  // When the failed app's owner is selected
  const response = await session(apps, { allow: ["fixture:shared"] }, (client) =>
    client.request("tools/call", { name: "fixture:shared", arguments: { appPath: "/apps/b" } }),
  );

  // Then the call reports that owner's load failure and nothing ran
  expect(outcome(response)).toMatchObject({
    ok: false,
    error: { _tag: "PluginLoadError", remediation: "Repair the plugin command module." },
  });
  expect(runs).toEqual([]);
});

test("authorization follows the selected owner: a default does not cover an external replacement, allow does, deny wins", async () => {
  // Given a reviewed bundled default owner in one app and an external replacement in another
  const apps = [
    generation("/apps/a", [owner("a", "db:snapshots", { source: "bundled" })]),
    generation("/apps/b", [owner("b", "db:snapshots")]),
  ];
  const call = (appPath?: string) => ({
    name: "db:snapshots",
    arguments: appPath === undefined ? {} : { appPath },
  });

  // When each owner is called under the default allowlist, an explicit allow, and allow plus deny
  const byDefault = await session(apps, { defaults: ["db:snapshots"] }, (client) =>
    Effect.all([client.request("tools/call", call()), client.request("tools/call", call("/apps/b"))]),
  );
  const allowed = await session(apps, { defaults: ["db:snapshots"], allow: ["db:snapshots"] }, (client) =>
    Effect.gen(function* () {
      yield* client.request("tools/call", call("/apps/b"));
      yield* client.request("tools/list");
      return yield* client.request("tools/call", call("/apps/b"));
    }),
  );
  const denied = await session(
    apps,
    { defaults: ["db:snapshots"], allow: ["db:snapshots"], deny: ["db:snapshots"] },
    (client) => client.request("tools/list"),
  );

  // Then the bundled owner inherits the default, the external one needs allow, and deny removes both
  expect(outcome(byDefault[0])).toMatchObject({ ok: true, result: { app: "a" } });
  expect(outcome(byDefault[1])).toMatchObject({
    error: { _tag: "McpToolNotAllowedError", toolId: "db:snapshots" },
  });
  expect(outcome(allowed)).toMatchObject({ ok: true, result: { app: "b" } });
  expect(toolNames(denied)).toEqual([]);
});

test("McpService.catalog keeps one cached catalog per app, never another app's", async () => {
  // Given two apps that define different plugin tools under the same options
  const apps = [
    generation("/apps/a", [owner("a", "fixture:a-only")]),
    generation("/apps/b", [owner("b", "fixture:b-only")]),
  ];
  const allow = ["fixture:a-only", "fixture:b-only"];

  // When each app's catalog is read, then the first is read again
  const catalogs = await session(apps, {}, () =>
    Effect.gen(function* () {
      const service = yield* McpService;
      return [
        yield* service.catalog({ allow, cwd: "/apps/a" }),
        yield* service.catalog({ allow, cwd: "/apps/b" }),
        yield* service.catalog({ allow, cwd: "/apps/a" }),
      ] as const;
    }),
  );

  // Then each catalog lists only its app's tool and the repeat reuses the first
  expect(catalogs[0].tools.map((tool) => tool.toolId)).toEqual(["fixture:a-only"]);
  expect(catalogs[1].tools.map((tool) => tool.toolId)).toEqual(["fixture:b-only"]);
  expect(catalogs[2]).toBe(catalogs[0]);
});

test("a non-string appPath fails on appPath before any app is selected", async () => {
  // Given a session app whose owner would run if the call fell back to the session directory
  const runs: string[] = [];
  const apps = [generation("/apps/a", [owner("a", "fixture:a-only", { runs })])];

  // When appPath is present but not a string
  const response = await session(apps, { allow: ["fixture:a-only"] }, (client) =>
    client.request("tools/call", { name: "fixture:a-only", arguments: { appPath: 42 } }),
  );

  // Then the call is rejected on appPath and nothing ran
  expect(outcome(response)).toMatchObject({ error: { _tag: "McpToolInputError", path: "appPath" } });
  expect(runs).toEqual([]);
});
