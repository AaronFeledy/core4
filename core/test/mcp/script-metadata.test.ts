import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileBunShellScriptCommands } from "@lando/engine/cache/command-compiler";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { discoverBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import { type McpDispatchDeps, dispatchTool } from "@lando/mcp/dispatch";
import type { McpCommandEntry, McpToolInput } from "@lando/mcp/registry";
import { createRedactor } from "@lando/sdk/secrets";
import { LandofileService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect, Layer } from "effect";
import { mcpRegistryWithToolingEntries } from "../../src/cli/commands/meta/mcp.ts";
import { withCwd } from "../_support/temp-cwd.ts";
import { environmentResolverLayer, literalLandofile } from "../_support/value-contracts.ts";

const source = [
  "# ---",
  "# desc: Inspect inputs",
  "# flags:",
  "#   mode:",
  "#     required: true",
  "#   loud:",
  "#     boolean: true",
  "#     default: true",
  "# args:",
  "#   target:",
  "#     required: true",
  "# ---",
  'echo "$LANDO_FLAG_MODE|$LANDO_FLAG_LOUD|$LANDO_ARG_TARGET"',
  "",
].join("\n");

const withScript = async (run: (root: string, path: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-script-input-"));
  const path = join(root, ".lando/scripts/inspect.bun.sh");
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: mcp-script\n");
    await writeFile(path, source);
    await withCwd(root, () => run(root, path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const project = async (root: string) =>
  mcpRegistryWithToolingEntries(
    { commandEntries: [] },
    compileBunShellScriptCommands(await Effect.runPromise(discoverBunShellScripts({ appRoot: root }))),
  );

const retainedDispatch = (root: string, entry: McpCommandEntry, input: McpToolInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.mergeAll(
          BunProcessRunner.layer,
          Layer.succeed(Context.Service<unknown>("script-mcp-runtime"), {}),
          environmentResolverLayer(),
          PrivateFileAccessService.layer,
          Layer.succeed(
            LandofileService,
            LandofileService.of({
              discover: Effect.succeed(literalLandofile({ name: "mcp-script" }, root)),
            }),
          ),
        ),
      );
      const deps: McpDispatchDeps = {
        registry: new Map([[entry.spec.id, entry]]),
        effective: new Set([entry.spec.id]),
        allowlistSource: "tooling",
        redactor: createRedactor("secrets"),
        resultRedactor: (tokens) => Effect.succeed(createRedactor("secrets", { values: tokens })),
        execute: (target, values) =>
          target.spec.run(values).pipe(
            Effect.provide(context),
            Effect.map((value) => ({ _tag: "success", value }) as const),
            Effect.catch((error) =>
              Effect.succeed({ _tag: "failure", error, additionalErrors: [] } as const),
            ),
          ),
      };
      return yield* dispatchTool({ toolId: entry.spec.id, input }, deps);
    }),
  );

test.each([false, true])("exposes named script inputs only with tooling=%s", async (tooling) => {
  // Given
  await withScript(async (root) => {
    const registry = await project(root);
    // When
    const catalog = buildCatalog({
      ...registry,
      effective: computeEffectiveAllowlist({ defaults: ["app:inspect"] }),
      options: { tooling },
    });
    // Then
    expect(catalog.tools).toHaveLength(tooling ? 1 : 0);
    if (tooling)
      expect(catalog.tools[0]?.inputSchema).toMatchObject({
        properties: {
          flags: { properties: { mode: { type: "string" }, loud: { type: "boolean" } }, required: ["mode"] },
          args: { properties: { target: { type: "string" } }, required: ["target"] },
        },
      });
  });
});

test("omits disabled scripts from the opt-in MCP projection", async () => {
  // Given
  await withScript(async (root, path) => {
    await writeFile(path, source.replace("# desc:", "# disabled: true\n# desc:"));
    // When
    const registry = await project(root);
    // Then
    expect(registry.toolingEntries).toEqual([]);
  });
});

test("dispatches named flags and args through the existing script fallback without a planner or provider", async () => {
  // Given
  await withScript(async (root) => {
    const entry = (await project(root)).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing script projection");
    // When
    const result = await Effect.runPromise(
      retainedDispatch(root, entry, {
        flags: { mode: "two words", loud: true },
        args: { target: "--literal" },
      }),
    );
    // Then
    expect(result.envelope).toMatchObject({
      ok: true,
      result: { stdout: "two words|true|--literal\n", exitCode: 0 },
    });
  });
});

test.each([
  { change: "disabled", tag: "ToolingDisabledError" },
  { change: "renamed-input", tag: "ToolingInputError" },
  { change: "false-default", tag: "ToolingInputError" },
])("admits $change according to the retained script contract", async ({ change, tag }) => {
  // Given: retain the original spec, then change either the script metadata or the call's boolean value.
  await withScript(async (root, path) => {
    const entry = (await project(root)).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing script projection");
    const marker = join(root, "executed");
    const edited =
      change === "disabled"
        ? source.replace("# desc:", "# disabled: true\n# desc:")
        : change === "renamed-input"
          ? source.replace("#   mode:", "#   renamed:")
          : source;
    await writeFile(path, `${edited}\necho executed > ${marker}\n`);
    // When
    const result = await Effect.runPromise(
      retainedDispatch(root, entry, {
        flags: { mode: "dev", loud: change !== "false-default" },
        args: { target: "target" },
      }),
    );
    // Then
    if (change === "false-default") {
      expect(result.envelope).toMatchObject({
        ok: true,
        result: { stdout: "dev|false|target\n", exitCode: 0 },
      });
      expect(await Bun.file(marker).exists()).toBe(true);
    } else {
      expect(result.envelope).toMatchObject({ ok: false, error: { _tag: tag } });
      expect(await Bun.file(marker).exists()).toBe(false);
    }
  });
});

test("refuses retained positional order changes before executing the script body", async () => {
  // Given: serialize named inputs against first,second, then execute against second,first.
  await withScript(async (root, path) => {
    const ordered = "# ---\n# args:\n#   first:\n#   second:\n# ---\n";
    await writeFile(path, `${ordered}echo original\n`);
    const entry = (await project(root)).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing script projection");
    const marker = join(root, "executed");
    await writeFile(marker, "unchanged");
    await writeFile(
      path,
      `${ordered.replace("#   first:\n#   second:", "#   second:\n#   first:")}echo "$LANDO_ARG_FIRST|$LANDO_ARG_SECOND" > ${marker}\n`,
    );
    // When
    const result = await Effect.runPromise(
      retainedDispatch(root, entry, { args: { first: "first-one", second: "second-two" } }),
    );
    // Then
    expect(await Bun.file(marker).text()).toBe("unchanged");
    expect(result.envelope).toMatchObject({ ok: false, error: { _tag: "ToolingInputError" } });
  });
});

const rawSource = "# ---\n# ---\necho raw\n";
test.each([
  { change: "default", before: source, after: source.replace("#     default: true", "#     default: false") },
  {
    change: "required",
    before: source,
    after: source.replaceAll("#     required: true", "#     required: false"),
  },
  {
    change: "choices",
    before: source,
    after: source.replace("#   mode:", "#   mode:\n#     choices: [dev]"),
  },
  {
    change: "raw to declared",
    before: rawSource,
    after: source.replaceAll("#     required: true", "#     required: false"),
  },
  { change: "declared to raw", before: source, after: rawSource },
])("refuses retained $change metadata before script execution", async ({ before, after }) => {
  // Given
  await withScript(async (root, path) => {
    await writeFile(path, before);
    const entry = (await project(root)).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing script projection");
    const marker = join(root, "executed");
    await writeFile(path, `${after}\necho executed > ${marker}\n`);
    // When
    const result = await Effect.runPromise(
      retainedDispatch(
        root,
        entry,
        before === rawSource
          ? {}
          : {
              flags: { mode: "dev", loud: true },
              args: { target: "target" },
            },
      ),
    );
    // Then
    expect(result.envelope).toMatchObject({ ok: false, error: { _tag: "ToolingInputError" } });
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});

test.each(["body", "description"])("allows retained %s-only script edits", async (change) => {
  // Given
  await withScript(async (root, path) => {
    const entry = (await project(root)).toolingEntries?.[0];
    if (entry === undefined) throw new Error("Missing script projection");
    await writeFile(
      path,
      change === "body"
        ? source.replace(
            'echo "$LANDO_FLAG_MODE|$LANDO_FLAG_LOUD|$LANDO_ARG_TARGET"',
            'echo "edited:$LANDO_ARG_TARGET"',
          )
        : source.replace("Inspect inputs", "Updated description"),
    );
    // When
    const result = await Effect.runPromise(
      retainedDispatch(root, entry, {
        flags: { mode: "dev", loud: true },
        args: { target: "target" },
      }),
    );
    // Then
    expect(result.envelope).toMatchObject({
      ok: true,
      result: {
        stdout: change === "body" ? "edited:target\n" : "dev|true|target\n",
      },
    });
  });
});
