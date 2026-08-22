import { describe, expect, test } from "bun:test";

import { Cause, Context, Effect, Exit, Schema } from "effect";

import { ToolingCommandLookupError } from "@lando/sdk/errors";
import { type ExecutableCommandInput, type ExecutableCommandSpec, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { builtInCommandCatalog, builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { validateEventCommandInput } from "../../src/cli/event-command-input.ts";
import { resolveEventCommandTarget } from "../../src/cli/event-command-target.ts";
import {
  isPluginOwnedCommandId,
  pluginOwnedCommandInputFromArgv,
  renderPluginOwnedCommandHelp,
} from "../../src/cli/run-plugin-owned-command.ts";
import { PluginContributionGraph } from "../../src/testing/engine-layers.ts";

const DbImportResult = Schema.Struct({
  imported: Schema.Boolean,
  host: Schema.optional(Schema.String),
});

const makeDbImportSpec = (): ExecutableCommandSpec => ({
  id: "db:import",
  summary: "Import a database dump.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    host: { type: "option", description: "Database host" },
  },
  args: {
    file: { type: "string" },
  },
  strict: false,
  resultSchema: DbImportResult,
  run: (input: ExecutableCommandInput) =>
    Effect.succeed({
      imported: true,
      ...(typeof input.flags.host === "string" ? { host: input.flags.host } : {}),
    }),
});

const makeDbImportPlugin = () => {
  const spec = makeDbImportSpec();
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@example/db-fixture",
    version: "1.0.0",
    api: 4,
    contributes: { commands: ["db:import"] },
  });
  return definePlugin({
    name: manifest.name,
    manifest,
    commands: new Map([["db:import", async () => spec]]),
  });
};

const graphContextForPlugin = (plugin: ReturnType<typeof makeDbImportPlugin>): Context.Context<never> => {
  const load = plugin.commands?.get("db:import");
  if (load === undefined) throw new Error("Expected db:import command loader on fixture plugin.");
  return Context.add(Context.empty(), PluginContributionGraph, {
    plugins: [],
    certificateAuthorities: [],
    commands: [{ id: "db:import", pluginName: plugin.name, source: "explicit", load }],
    hostContext: Context.empty(),
  });
};

describe("plugin-owned command dispatch", () => {
  test("does not register db:import as a built-in", () => {
    // Given
    const catalogIds = Object.keys(builtInCommandCatalog);
    const entryIds = builtInCommandEntries.map((entry) => entry.spec.id);

    // When
    const catalogHasDbImport = catalogIds.includes("db:import");
    const entriesHaveDbImport = entryIds.includes("db:import");
    const entriesHaveDbNamespace = entryIds.some((id) => id.startsWith("db:"));

    // Then
    expect(catalogHasDbImport).toBe(false);
    expect(entriesHaveDbImport).toBe(false);
    expect(entriesHaveDbNamespace).toBe(false);
  });

  test("resolves db:import from a definePlugin contribution graph as kind plugin", async () => {
    // Given
    const plugin = makeDbImportPlugin();
    const context = graphContextForPlugin(plugin);

    // When
    const target = await Effect.runPromise(resolveEventCommandTarget("db:import", context, []));

    // Then
    expect(target.kind).toBe("plugin");
    expect(target.spec.id).toBe("db:import");
    expect(target.spec.namespace).toBe("db");
    expect(target.spec.bootstrap).toBe("app");
  });

  test("rejects unknown db:nope as a plugin lookup miss", async () => {
    // Given
    const plugin = makeDbImportPlugin();
    const context = graphContextForPlugin(plugin);

    // When
    const exit = await Effect.runPromiseExit(resolveEventCommandTarget("db:nope", context, []));

    // Then
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(ToolingCommandLookupError);
    if (error instanceof ToolingCommandLookupError) {
      expect(error.target).toBe("db:nope");
      expect(error.targetKind).toBe("plugin");
    }
  });

  test("treats a colon-namespaced token as a plugin-owned command id", () => {
    // Given / When / Then
    expect(isPluginOwnedCommandId("db:import")).toBe(true);
    expect(isPluginOwnedCommandId("db:nope")).toBe(true);
    expect(isPluginOwnedCommandId("start")).toBe(false);
    expect(isPluginOwnedCommandId("--help")).toBe(false);
  });

  test("renders plugin spec flag tokens for help", () => {
    // Given
    const spec = makeDbImportSpec();

    // When
    const help = renderPluginOwnedCommandHelp(spec);

    // Then
    expect(help).toContain("db:import");
    expect(help).toContain("--host");
    expect(help).toContain("FILE");
  });

  test("parses fixture plugin argv and decodes the spec resultSchema", async () => {
    // Given
    const spec = makeDbImportSpec();

    // When
    const parsed = pluginOwnedCommandInputFromArgv(spec, ["--host", "db.example", "dump.sql"]);
    const input = await Effect.runPromise(validateEventCommandInput(spec, parsed));
    const result = {
      imported: true,
      ...(typeof input.flags.host === "string" ? { host: input.flags.host } : {}),
    };

    // Then
    expect(input.flags.host).toBe("db.example");
    expect(input.args.file).toBe("dump.sql");
    expect(Schema.decodeUnknownSync(spec.resultSchema)(result)).toEqual({
      imported: true,
      host: "db.example",
    });
  });
});
