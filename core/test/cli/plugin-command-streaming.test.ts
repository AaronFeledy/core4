import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContributionGraphShape } from "@lando/engine/plugins/contribution-graph";
import { createBufferedRendererIO } from "@lando/renderer/io";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { StreamFrame } from "@lando/sdk/schema";
import { StreamFrameSink } from "@lando/sdk/services";
import { Context, Effect, Option, Schema } from "effect";
import { setActiveRendererMode, setActiveResultFormat } from "../../src/cli/compiled-runtime.ts";
import { specOwnerPolicy } from "../../src/cli/flag-claims.ts";
import { type ResultFormat, commandResultFormats } from "../../src/cli/format-flags.ts";
import { BUNDLED_COMMAND_DESCRIPTORS } from "../../src/cli/generated/bundled-command-descriptors.ts";
import { splitCommandTokens } from "../../src/cli/invocation.ts";
import { createPluginCommandCatalog } from "../../src/cli/plugin-command-catalog.ts";
import { tryPluginCommandHelp } from "../../src/cli/plugin-command-help.ts";
import {
  pluginFlagDefinitions,
  renderPluginOwnedCommandHelp,
  tryPluginOwnedCommand,
} from "../../src/cli/run-plugin-owned-command.ts";
import type { CliInvocationContext } from "../../src/runtime/invocation-context.ts";

const Result = Schema.Struct({ done: Schema.Boolean, sawSink: Schema.Boolean });

/** A plugin command that streams a line through the sink when it has one. */
const liveSpec = (onRun: () => void = () => undefined): ExecutableCommandSpec => ({
  id: "fixture:stream",
  summary: "Stream fixture output.",
  namespace: "fixture",
  bootstrap: "minimal",
  streamingMode: "live",
  resultSchema: Result,
  run: () =>
    Effect.gen(function* () {
      const sink = yield* Effect.serviceOption(StreamFrameSink);
      if (Option.isSome(sink))
        yield* sink.value.emit({ _tag: "stdout", kind: "bytes", chunk: "first line\n" });
      onRun();
      return { done: true, sawSink: Option.isSome(sink) };
    }),
});

const collectedSpec = (onRun: () => void = () => undefined): ExecutableCommandSpec => {
  const { streamingMode: _live, ...spec } = liveSpec(onRun);
  return { ...spec, id: "fixture:collect", summary: "Collect fixture output." };
};

const graphFor = (spec: ExecutableCommandSpec): PluginContributionGraphShape => ({
  commands: [
    {
      id: spec.id,
      descriptor: { id: spec.id, summary: spec.summary ?? "" },
      load: async () => spec,
      pluginName: "@example/fixture",
      source: "explicit",
    },
  ],
  plugins: [],
  globalPlugins: [],
  certificateAuthorities: [],
  hostContext: Context.empty(),
});

const roots: string[] = [];
afterEach(async () => {
  setActiveResultFormat("text");
  setActiveRendererMode("lando");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const invocation = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-plugin-streaming-"));
  roots.push(cwd);
  const io = createBufferedRendererIO();
  const exitCodes: number[] = [];
  const context: CliInvocationContext = {
    cwd,
    env: { ...process.env },
    io,
    setExitCode: (code) => exitCodes.push(code),
  };
  return { io, exitCodes, context };
};

const dispatch = async (spec: ExecutableCommandSpec, format: ResultFormat, context: CliInvocationContext) => {
  setActiveResultFormat(format);
  setActiveRendererMode("plain");
  const catalog = createPluginCommandCatalog(undefined, () => Effect.succeed(graphFor(spec)), context);
  const row = await catalog.resolve(spec.id);
  if (row === undefined || "unavailable" in row || row.spec === undefined)
    throw new Error(`No loaded plugin row for ${spec.id}.`);
  const tokens = splitCommandTokens([], specOwnerPolicy(spec, pluginFlagDefinitions(spec)), "all").command;
  return tryPluginOwnedCommand(spec.id, row, tokens, undefined, catalog);
};

const framesOf = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(StreamFrame))(line));

describe("plugin command live streaming", () => {
  test("help advertises ndjson only for a command that streams live", () => {
    expect(renderPluginOwnedCommandHelp(liveSpec())).toContain("--format (text, json, yaml, ndjson)");
    const collected = renderPluginOwnedCommandHelp(collectedSpec());
    expect(collected).toContain("--format (text, json, yaml)");
    expect(collected).not.toContain("ndjson");
  });

  test("JSON help for a live plugin command lists ndjson in its advertised formats", async () => {
    // Given
    const { io, context } = await invocation();
    const spec = liveSpec();
    setActiveResultFormat("json");
    const catalog = createPluginCommandCatalog(undefined, () => Effect.succeed(graphFor(spec)), context);

    // When
    expect(await tryPluginCommandHelp(spec.id, catalog)).toBe(true);

    // Then
    expect(JSON.parse(io.stdout())).toMatchObject({
      result: { target: { canonicalId: spec.id, advertisedFormats: ["text", "json", "yaml", "ndjson"] } },
    });
  });

  test("the bundled descriptor table carries a module's live declaration for cold help", () => {
    const run = BUNDLED_COMMAND_DESCRIPTORS.find((descriptor) => descriptor.id === "schedule:run");
    const list = BUNDLED_COMMAND_DESCRIPTORS.find((descriptor) => descriptor.id === "schedule:list");
    expect(run?.streamingMode).toBe("live");
    expect(run?.flags.format?.options).toEqual([...commandResultFormats(run)]);
    expect(run?.flags.format?.options).toContain("ndjson");
    expect(list?.flags.format?.options).not.toContain("ndjson");
  });

  test.each(["json", "ndjson"] as const)(
    "--format=%s streams frames while the command runs and ends in one result frame",
    async (format) => {
      // Given: a live plugin command, recording stdout at the moment its run finishes.
      const { io, exitCodes, context } = await invocation();
      let atCompletion = "";
      const spec = liveSpec(() => {
        atCompletion = io.stdout();
      });

      // When
      expect(await dispatch(spec, format, context)).toBe(true);

      // Then: the streamed frame was on stdout before the command returned, and the
      // sequence ends in exactly one result frame carrying the result.
      expect(framesOf(atCompletion)).toEqual([{ _tag: "stdout", chunk: "first line\n" }]);
      const frames = framesOf(io.stdout());
      expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
      const terminal = frames.at(-1);
      expect(terminal?._tag).toBe("result");
      expect(terminal?._tag === "result" ? terminal.envelope : undefined).toMatchObject({
        ok: true,
        result: { done: true, sawSink: true },
      });
      expect(exitCodes.filter((code) => code !== 0)).toEqual([]);
    },
  );

  test("a command that does not stream refuses --format=ndjson before it runs", async () => {
    // Given
    const { io, exitCodes, context } = await invocation();
    let ran = false;
    const spec = collectedSpec(() => {
      ran = true;
    });

    // When
    expect(await dispatch(spec, "ndjson", context)).toBe(true);

    // Then: one result frame names the formats the command offers.
    const frames = framesOf(io.stdout());
    expect(frames).toHaveLength(1);
    expect(frames[0]?._tag === "result" ? frames[0].envelope : undefined).toMatchObject({
      ok: false,
      error: {
        _tag: "RendererSelectionError",
        message: expect.stringContaining("Allowed: text, json, yaml."),
      },
    });
    expect(exitCodes).toContain(2);
    expect(ran).toBe(false);
  });

  test("YAML collects instead of streaming: the run gets no sink", async () => {
    // Given
    const { io, context } = await invocation();

    // When
    expect(await dispatch(liveSpec(), "yaml", context)).toBe(true);

    // Then
    expect(Bun.YAML.parse(io.stdout())).toMatchObject({ ok: true, result: { done: true, sawSink: false } });
  });
});
