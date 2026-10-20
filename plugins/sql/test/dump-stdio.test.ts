import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { Renderer } from "@lando/sdk/services";
import { makeInteractionContractRenderer } from "@lando/sdk/test";

import { dbInputFromCommand, hostFile } from "../src/command-input.ts";
import { spec as exportSpec } from "../src/commands/export.ts";
import {
  STDIN_DUMP_PATH,
  STDOUT_DUMP_PATH,
  isNonRegularExistingPath,
  isStdinDumpArg,
  isStdoutDumpArg,
  resolveStdioDumpPath,
} from "../src/dump-stdio.ts";
import type { SqlPlan } from "../src/views.ts";
import { canUseFifo, mkfifo, withFifoDir } from "./support/fifo.ts";

const plan: SqlPlan = { id: "sql-app", name: "sql-app", root: "/tmp/sql-app", services: {} };

describe("stdio dump path aliases", () => {
  test("treats dash, /dev/stdout, and fd/1 as stdout dumps", () => {
    expect(isStdoutDumpArg("-")).toBe(true);
    expect(isStdoutDumpArg(STDOUT_DUMP_PATH)).toBe(true);
    expect(isStdoutDumpArg("/dev/fd/1")).toBe(true);
    expect(isStdoutDumpArg("/proc/self/fd/1")).toBe(true);
    expect(isStdoutDumpArg("dump.sql")).toBe(false);
    expect(isStdoutDumpArg(undefined)).toBe(false);
  });

  test("treats dash, /dev/stdin, and fd/0 as stdin dumps", () => {
    expect(isStdinDumpArg("-")).toBe(true);
    expect(isStdinDumpArg(STDIN_DUMP_PATH)).toBe(true);
    expect(isStdinDumpArg("/dev/fd/0")).toBe(true);
    expect(isStdinDumpArg("/proc/self/fd/0")).toBe(true);
    expect(isStdinDumpArg("dump.sql")).toBe(false);
  });

  test("resolves dash to /dev/stdout for export and /dev/stdin for import", () => {
    expect(resolveStdioDumpPath("-", "stdout")).toBe(STDOUT_DUMP_PATH);
    expect(resolveStdioDumpPath("-", "stdin")).toBe(STDIN_DUMP_PATH);
    expect(resolveStdioDumpPath("/tmp/dump.sql", "stdout")).toBe("/tmp/dump.sql");
  });

  test("hostFile maps dash through the command action", () => {
    expect(hostFile(plan, { service: "database", file: "-", action: "export" })).toBe(STDOUT_DUMP_PATH);
    expect(hostFile(plan, { service: "database", file: "-", action: "import" })).toBe(STDIN_DUMP_PATH);
    expect(hostFile(plan, { service: "database", file: "-", action: "seed" })).toBe(STDIN_DUMP_PATH);
  });

  test("dbInputFromCommand maps --force-tty onto forceTty", () => {
    const input = dbInputFromCommand("export", {
      argv: [],
      parsedArgv: [],
      flags: { "force-tty": true },
      args: { file: "-" },
    });
    expect(input.forceTty).toBe(true);
    expect(input.file).toBe("-");
  });

  test("db:export payloadStdout is true only for stdout dump args", () => {
    const input = {
      argv: [],
      parsedArgv: ["-"],
      flags: {},
      args: { file: "-" },
    };
    expect(exportSpec.payloadStdout?.(input)).toBe(true);
    expect(exportSpec.payloadStdout?.({ ...input, args: { file: "dump.sql" } })).toBe(false);
  });

  test("checksum for a stdout dump renders on stderr", async () => {
    const render = exportSpec.render;
    if (render === undefined) throw new Error("expected db:export render hook");
    const renderer = makeInteractionContractRenderer();
    await Effect.runPromise(
      render({
        input: { argv: [], parsedArgv: ["-"], flags: {}, args: { file: "-" } },
        result: {
          service: "database",
          steps: [],
          digest: "ab".repeat(32),
          sizeBytes: 12,
        },
        stdout: "",
        stderr: "",
        exitCode: 0,
      }).pipe(Effect.provideService(Renderer, Renderer.of(renderer.service))),
    );
    expect(renderer.stdout()).toBe("");
    expect(renderer.stderr()).toBe(`sha256 ${"ab".repeat(32)} 12 bytes\n`);
  });
});

describe("non-regular dump destinations", () => {
  test("detects an existing FIFO as a special path", async () => {
    if (!canUseFifo) return;
    await withFifoDir(async (dir) => {
      const fifo = join(dir, "dump.fifo");
      await mkfifo(fifo);
      expect(await Effect.runPromise(isNonRegularExistingPath(fifo))).toBe(true);
      expect((await stat(fifo)).isFIFO()).toBe(true);
    });
  });

  test("treats a missing path as regular so export can create a file", async () => {
    expect(await Effect.runPromise(isNonRegularExistingPath("/tmp/lando-missing-dump-path.sql"))).toBe(false);
  });
});
