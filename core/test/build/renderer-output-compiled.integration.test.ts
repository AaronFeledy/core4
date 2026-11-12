import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StreamFrame } from "@lando/sdk/schema";
import * as Schema from "effect/Schema";
import { withFifoChild } from "../cli/stdio-file-status-support.ts";
import { runCaptured } from "./fixtures/host-execution-process.ts";

const suppliedBinary = process.env.LANDO_TEST_COMPILED_CLI;
const windows = process.platform === "win32";
const toolText = "HOST_RENDERER_ACCEPTANCE";
// Match color parameters anywhere in an SGR, including combined bold/color sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI acceptance must match the terminal escape byte.
const chromaticSgr = /\x1b\[(?:\d+;)*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|[34]8(?:;\d+)+)(?:;\d+)*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Detect cursor movement and erase escape sequences.
const rewind = /\x1b\[[\d;]*[AFHJK]/;

describe.skipIf(suppliedBinary === undefined)("supplied compiled renderer output", () => {
  let root = "";
  let binary = "";
  let app = "";
  let env: NodeJS.ProcessEnv = {};

  const runPty = async (args: readonly string[], overrides: NodeJS.ProcessEnv) => {
    let output = "";
    const decoder = new TextDecoder();
    const child = Bun.spawn({
      cmd: [binary, ...args],
      cwd: app,
      env: { ...env, ...overrides },
      timeout: 15_000,
      terminal: {
        cols: 160,
        rows: 30,
        data: (terminal, bytes) => {
          output += decoder.decode(bytes, { stream: true });
          if (output.length > 128 * 1024) terminal.close();
        },
      },
    });
    try {
      const exitCode = await child.exited;
      output += decoder.decode();
      expect(output.length).toBeLessThanOrEqual(128 * 1024);
      expect(exitCode, output).toBe(0);
      return output;
    } finally {
      child.terminal?.close();
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  };

  beforeAll(async () => {
    if (suppliedBinary === undefined || suppliedBinary === "")
      throw new Error("Supply a native binary with LANDO_TEST_COMPILED_CLI");
    const source = resolve(suppliedBinary);
    if (!(await stat(source)).isFile()) throw new Error(`Supplied compiled CLI is not a file: ${source}`);
    root = await mkdtemp(join(tmpdir(), "lando-renderer-compiled-"));
    app = join(root, "app");
    await mkdir(app);
    binary = join(root, windows ? "lando.exe" : "lando");
    await copyFile(source, binary);
    // Neither ambient Lando configuration nor forced color owns these runs.
    env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(LANDO_|BUN_|PWD$|NO_COLOR$|FORCE_COLOR$|CLICOLOR(?:_FORCE)?$|TERM$|CI$)/i.test(key),
      ),
    );
    Object.assign(env, {
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
      TERM: "xterm-256color",
    });
    await writeFile(
      join(app, ".lando.yml"),
      Bun.YAML.stringify(
        {
          name: "renderer-compiled",
          tooling: { "host-plain": { service: ":host", cmd: `echo ${toolText}` } },
        },
        null,
        2,
      ),
    );
    const refresh = await runCaptured([binary, "app:cache:refresh", "--format=json"], app, env);
    expect(refresh.exitCode, refresh.stderr + refresh.stdout).toBe(0);
  }, 40_000);

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  // Bun terminal spawning is POSIX-only, matching the compiled host-execution harness.
  describe.skipIf(windows)("POSIX PTY color policy", () => {
    test("keeps help colored on a capable terminal", async () => {
      // Given / When
      const output = await runPty(["--help"], { TERM: "xterm-256color" });
      // Then
      expect([...output.matchAll(chromaticSgr)].length, output).toBeGreaterThan(0);
    }, 20_000);

    for (const args of [["--help"], ["host-plain"]]) {
      test(`honors NO_COLOR for ${args[0]}`, async () => {
        // Given / When
        const output = await runPty(args, { TERM: "xterm-256color", NO_COLOR: "1" });
        // Then
        expect([...output.matchAll(chromaticSgr)], output).toHaveLength(0);
        if (args[0] === "host-plain") expect(output).toContain(toolText);
      }, 20_000);

      test(`avoids color and rewinds with TERM=dumb for ${args[0]}`, async () => {
        // Given / When
        const output = await runPty(args, { TERM: "dumb" });
        // Then
        expect([...output.matchAll(chromaticSgr)], output).toHaveLength(0);
        expect(output).not.toMatch(rewind);
        if (args[0] === "host-plain") expect(output).toContain(toolText);
      }, 20_000);
    }
  });

  test("ends JSON validation-failure frames with exactly one failed result", async () => {
    // Given / When: invalid --since is rejected before any provider is resolved.
    const result = await runCaptured([binary, "logs", "--since=invalid", "--format=json"], app, env);
    // Then: decode every line, not just the final envelope.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("");
    const frames = result.stdout
      .trimEnd()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
    const events = frames.filter((frame) => frame._tag === "event");
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((frame) => frame.event)).toContain("cli-app:logs-init");
    for (const frame of events) {
      expect(frame.event).not.toMatch(/^(?:pre-bootstrap-|post-bootstrap|ready$)/);
    }
    expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({
      _tag: "result",
      envelope: { ok: false, error: { _tag: "ToolingExecError" } },
    });
  }, 35_000);

  for (const args of [["--version"], ["version", "--format=json"]]) {
    test.skipIf(windows)(
      `hands a shared pipe back blocking after ${args.join(" ")} (#1466)`,
      async () => {
        // Given / When: the native binary writes to a pipe the test keeps open.
        await withFifoChild([binary, ...args], { cwd: app, env }, async (child) => {
          // Then: it succeeds, and the helper checks O_NONBLOCK on the shared description.
          expect(await child.exited).toBe(0);
        });
      },
      20_000,
    );
  }
});
