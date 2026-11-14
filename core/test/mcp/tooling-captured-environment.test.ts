import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Context, Effect } from "effect";
import { readMcpToolingCatalog } from "../../src/cli/commands/meta/mcp-tooling-catalog";
import { CliInvocation } from "../../src/runtime/invocation-context";

test("retained tooling diagnostics reuse the session environment despite a different ambient environment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-mcp-captured-environment-"));
  const env = {
    SESSION_ONLY: "captured-private-canary",
    LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
    LANDO_USER_DATA_ROOT: join(cwd, "data"),
    LANDO_USER_CONF_ROOT: join(cwd, "conf"),
  };
  try {
    await writeFile(join(cwd, ".lando.yml"), "name: [unparseable\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        cwd,
        cacheRoot: env.LANDO_USER_CACHE_ROOT,
        env,
        landofile: { name: "captured" },
        entries: [
          {
            _tag: "Unavailable",
            id: "app:deploy",
            sourceKind: "tooling",
            visibility: "public",
            summary: "Deploy",
            diagnostic: { _tag: "FixtureError", message: "Invalid task" },
          },
        ],
      }),
    );
    const generation = { key: cwd, context: Context.makeUnsafe<unknown>(new Map()), commands: new Map() };
    const read = () =>
      Effect.runPromise(
        readMcpToolingCatalog(generation).pipe(
          Effect.provideService(CliInvocation, {
            cwd,
            env,
            io: createBufferedRendererIO(),
            setExitCode: () => undefined,
          }),
        ),
      );

    const first = await read();
    const repeated = await read();
    expect(first.unavailable).toMatchObject([{ commandId: "app:deploy", message: "Invalid task" }]);
    expect(repeated).toEqual(first);
    expect(JSON.stringify(repeated)).not.toContain(env.SESSION_ONLY);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
