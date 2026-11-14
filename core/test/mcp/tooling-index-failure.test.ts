import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Context, Effect, Schema } from "effect";
import { readMcpToolingCatalog } from "../../src/cli/commands/meta/mcp-tooling-catalog";
import { CliInvocation } from "../../src/runtime/invocation-context";
import { openStdioSession } from "./stdio-session";

const cli = resolve(import.meta.dir, "../../bin/lando.ts");
const landofile = (constraint = "") =>
  `name: index-failure\n${constraint}tooling:\n  healthy:\n    service: ":host"\n    cmd: echo healthy\n  broken:\n    wrapper: true\n`;
const tools = (response: Schema.JsonObject) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) }),
  )(response).result.tools.map((tool) => tool.name);

test.each(["missing", "invalid", "stale"] as const)(
  "diagnostics fail visibly and retain the published catalog when refresh leaves a %s index",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "lando-mcp-index-failure-"));
    const cacheRoot = join(root, "cache");
    await writeFile(join(root, ".lando.yml"), landofile());
    const env = {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_SKIP_VERSION_CONSTRAINT: "1",
      PATH: "/no-such-path",
    };
    const session = openStdioSession({
      command: [process.execPath, cli, "mcp", "--tooling"],
      cwd: root,
      env,
    });
    try {
      await session.initialize();
      const initial = await session.request("resources/read", { uri: "lando://diagnostics" });
      expect(initial).toHaveProperty("result");
      const published = tools(await session.request("tools/list"));
      expect(published).toContain("app:healthy");
      expect(published).not.toContain("app:broken");
      await writeFile(join(root, ".lando.yml"), landofile("lando: >=99\n"));
      const path = appToolingCompilationCachePath(cacheRoot, root);
      if (status === "missing") await rm(path);
      if (status === "invalid") await writeFile(path, "invalid index");

      const response = await session.request("resources/read", { uri: "lando://diagnostics" });

      expect(response).toMatchObject({
        error: { code: -32603, data: { _tag: "ToolingCommandUnavailableError" } },
      });
      const error = Schema.decodeUnknownSync(
        Schema.Struct({ message: Schema.String, data: Schema.Struct({ remediation: Schema.String }) }),
      )(response.error);
      expect(error.message).toContain(`${status}-cache`);
      expect(error.data.remediation).not.toContain("app:cache:refresh");
      expect(tools(await session.request("tools/list"))).toEqual(published);
      const listed = Bun.spawn([process.execPath, cli, "mcp", "--list", "--tooling", "--format=json"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(listed.stdout).text(),
        new Response(listed.stderr).text(),
        listed.exited,
      ]);
      expect(exit, stdout + stderr).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: {
          _tag: "ToolingCommandUnavailableError",
          reason: `${status}-cache`,
          sourcePath: join(root, ".lando.yml"),
          ...(status === "stale" ? { staleReason: "source" } : {}),
        },
      });
      expect((await session.finish()).exit).toBe(0);
    } finally {
      session.child.kill();
      await session.child.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("tooling catalog is legitimately empty outside an app", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-outside-app-"));
  try {
    const catalog = await Effect.runPromise(
      readMcpToolingCatalog({
        key: root,
        context: Context.makeUnsafe<unknown>(new Map()),
        commands: new Map(),
      }).pipe(
        Effect.provideService(CliInvocation, {
          cwd: root,
          env: { LANDO_USER_CACHE_ROOT: join(root, "cache") },
          io: createBufferedRendererIO(),
          setExitCode: () => undefined,
        }),
      ),
    );
    expect(catalog).toEqual({ revision: "missing", entries: [], unavailable: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
