import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { makeNestedExecute } from "@lando/mcp/execute";
import { resolveCommandCompletion } from "@lando/sdk/command-result";
import { Context, Effect, Schema } from "effect";

test("retained MCP execution resolves each call's appPath with a fresh memo", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-discovery-"));
  const left = join(root, "left");
  const right = join(root, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(join(root, ".lando.stop"), "");
  await writeFile(join(left, ".lando.yml"), "name: left\n");
  await writeFile(join(right, ".lando.yml"), "name: right\n");
  const execute = makeNestedExecute(
    Context.makeUnsafe<unknown>(new Map()),
    { sink: { emit: () => Effect.void }, finish: () => Effect.void },
    {
      execute: (command) =>
        Effect.exit(Effect.map(command, (value) => resolveCommandCompletion("app:discovery", value))),
    },
  );
  const entry = {
    spec: {
      id: "app:discovery",
      summary: "Discover",
      resultSchema: Schema.Unknown,
      run: () => findAppRoot(),
    },
  };
  const input = { argv: [], args: {}, flags: {}, interaction: "non-interactive" as const };
  try {
    expect<unknown>(await Effect.runPromise(execute(entry, { ...input, appPath: left }))).toEqual({
      _tag: "success",
      value: left,
      exitCode: 0,
    });
    expect<unknown>(await Effect.runPromise(execute(entry, { ...input, appPath: right }))).toEqual({
      _tag: "success",
      value: right,
      exitCode: 0,
    });
    await rm(join(left, ".lando.yml"));
    expect<unknown>(await Effect.runPromise(execute(entry, { ...input, appPath: left }))).toEqual({
      _tag: "success",
      value: undefined,
      exitCode: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
