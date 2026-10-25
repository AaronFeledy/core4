import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAppRoot } from "@lando/landofile/discovery";
import { makeNestedExecute } from "@lando/mcp/execute";
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
    { emit: () => Effect.void },
    {
      execute: (command) => Effect.exit(command),
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
    expect(await Effect.runPromise(execute(entry, { ...input, appPath: left }))).toEqual({
      _tag: "success",
      value: left,
    });
    expect(await Effect.runPromise(execute(entry, { ...input, appPath: right }))).toEqual({
      _tag: "success",
      value: right,
    });
    await rm(join(left, ".lando.yml"));
    expect(await Effect.runPromise(execute(entry, { ...input, appPath: left }))).toEqual({
      _tag: "success",
      value: undefined,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
