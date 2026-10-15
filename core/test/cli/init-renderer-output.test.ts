import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Layer } from "effect";

import * as LandoEventService from "@lando/engine/services/event-service";
import { RedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, Renderer } from "@lando/sdk/services";

import { makeInitOutput } from "../../src/cli/commands/init-output.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { runPostInit } from "../../src/recipes/post-init/runtime.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";

const redaction = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: () => Effect.void,
    forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["private-token"] })),
  }),
);

const withTemp = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-output-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// Interpret cursor movement instead of stripping ANSI: a missed rewind leaves old headers visible.
const screenText = (chunks: readonly string[], columns: number): string => {
  const lines: string[][] = [[]];
  let row = 0;
  let column = 0;
  const escapes = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]|[\\s\\S]`, "gu");
  for (const token of chunks.join("").match(escapes) ?? []) {
    if (token.startsWith("\u001b[")) {
      if (token.endsWith("A")) row = Math.max(0, row - Number(token.slice(2, -1) || "1"));
      if (token.endsWith("J")) {
        lines[row] = (lines[row] ?? []).slice(0, column);
        lines.length = row + 1;
      }
    } else if (token === "\r") column = 0;
    else if (token === "\n") {
      row += 1;
      lines[row] ??= [];
    } else {
      if (column === columns) {
        row += 1;
        column = 0;
      }
      lines[row] ??= [];
      const line = lines[row];
      if (line !== undefined) line[column++] = token;
    }
  }
  return lines.map((line) => line.join("")).join("\n");
};

describe("init recipe output through the command renderer", () => {
  test("retains the real Drupal CMS post-init message above one completed TTY tree", async () => {
    await withTemp(async (root) => {
      const chunks: string[] = [];
      const stdout = Object.assign(new EventEmitter(), {
        columns: 120,
        rows: 30,
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      });
      const base = createBufferedRendererIO({ isTTY: true, terminalColumns: 120, terminalRows: 30 });
      const io = { ...base, externalOutputStream: stdout as unknown as NodeJS.WriteStream };
      await runWithRendererHandling(
        Effect.gen(function* () {
          const events = yield* EventService;
          const postInitIO = yield* makeInitOutput("text");
          return yield* Effect.tryPromise(() =>
            initApp({
              cwd: root,
              userDataRoot: join(root, "data"),
              recipe: "drupal-cms",
              name: "cms-output",
              full: false,
              yes: true,
              nonInteractive: true,
              events,
              postInitIO,
            }),
          );
        }),
        {
          runtime: Layer.merge(LandoEventService.layer, redaction),
          rendererMode: "lando",
          io,
          command: "apps:init",
          invocation: {
            commandId: "apps:init",
            argv: [],
            args: {},
            flags: {},
            cwd: root,
            invocationId: "init-output",
          },
          formatError: String,
          setExitCode: () => undefined,
          render: () => undefined,
        },
      );
      const screen = screenText(chunks, 120);
      expect(screen).toContain("Run 'lando start'");
      expect(screen.match(/\u256D\u2500 apps:init/g)).toHaveLength(1);
      expect(screen.indexOf("Run 'lando start'")).toBeLessThan(screen.indexOf("\u256D\u2500 apps:init"));
      expect(screen).toContain("Rendered 2 files");
      expect(screen).toContain("Ran 1 action");
      expect(base.stdout()).toBe("");
    });
  });

  test.each(["json", "yaml", "ndjson"] as const)(
    "preserves %s stdout and redacts both recipe channels",
    async (format) => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(
        Effect.gen(function* () {
          const output = yield* makeInitOutput(format);
          yield* Effect.promise(async () => {
            await output.out("recipe private-token");
          });
          yield* Effect.promise(async () => {
            await output.err("warning private-token");
          });
          return {};
        }),
        {
          runtime: redaction,
          rendererMode: "lando",
          resultFormat: format,
          io,
          formatError: String,
          setExitCode: () => undefined,
          render: () => undefined,
        },
      );
      expect(io.stderr()).toContain("recipe [redacted]");
      expect(io.stderr()).toContain("warning [redacted]");
      expect(io.stderr()).not.toContain("private-token");
      expect(io.stdout()).not.toContain("recipe");
      if (format === "json") expect(JSON.parse(io.stdout())).toHaveProperty("ok", true);
    },
  );

  test("JSON renderer keeps recipe messages as structured stderr events", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const output = yield* makeInitOutput("text");
        yield* Effect.promise(async () => {
          await output.out("recipe private-token");
        });
        yield* Effect.promise(async () => {
          await output.err("warning private-token");
        });
      }),
      {
        runtime: redaction,
        rendererMode: "json",
        io,
        formatError: String,
        setExitCode: () => undefined,
        render: () => undefined,
      },
    );
    expect(io.stdout()).toBe("");
    const events = io.stderrLines().map((line) => JSON.parse(line).payload);
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "message.info", body: "recipe [redacted]" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ _tag: "message.warn", body: "warning [redacted]" }),
    );
  });

  test("post-init waits for asynchronous renderer output before completing", async () => {
    const lines: string[] = [];
    const delayed = (chunk: string) =>
      Effect.promise(async () => {
        await Bun.sleep(10);
        lines.push(chunk);
      });
    const renderer = Renderer.of({
      id: "plain",
      capabilities: { color: false, animation: false, interactive: false, notifications: false },
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: { stdout: delayed, stderr: delayed },
    });
    const io = await Effect.runPromise(
      makeInitOutput("text").pipe(Effect.provide(Layer.merge(redaction, Layer.succeed(Renderer, renderer)))),
    );
    await runPostInit({
      actions: [
        { type: "message", text: "first" },
        { type: "message", text: "second" },
      ],
      destination: "/tmp",
      recipeId: "output",
      appName: "output",
      answers: {},
      io,
    });
    expect(lines).toEqual(["first\n", "second\n"]);
  });

  test("post-init awaits an asynchronous warning before running its command", async () => {
    let warned = false;
    await runPostInit({
      actions: [{ type: "bun", verb: "x", spec: "prettier" }],
      destination: "/tmp",
      recipeId: "output",
      appName: "output",
      answers: {},
      io: {
        out: () => undefined,
        err: async () => {
          await Bun.sleep(10);
          warned = true;
        },
      },
      spawner: {
        spawn: async () => {
          expect(warned).toBe(true);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(warned).toBe(true);
  });

  test("native dispatcher emits a parseable JSON envelope for real Drupal CMS init", async () => {
    await withTemp(async (root) => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          resolve(import.meta.dirname, "../../bin/lando.ts"),
          "init",
          "cms-json",
          "--recipe=drupal-cms",
          "--yes",
          "--format=json",
        ],
        cwd: root,
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toHaveProperty("ok", true);
      expect(stderr).toContain("Run 'lando start'");
    });
  });
});
