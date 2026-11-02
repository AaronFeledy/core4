import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { McpListResultSchema } from "../../src/cli/commands/meta/mcp-list";

let root: string;
const cli = resolve(import.meta.dir, "../../bin/lando.ts");
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-mcp-plugin-cli-"));
  const path = join(root, ".lando/plugins/fixture");
  await mkdir(path, { recursive: true });
  await writeFile(join(root, ".lando.yml"), "name: mcp-fixture\n");
  const manifest = {
    name: "@lando/sql",
    version: "1.0.0",
    api: 4,
    entry: "index.ts",
    contributes: {
      commands: [
        { id: "db:snapshots", summary: "External replacement", mcpAllowed: true },
        { id: "fixture:inspect", summary: "External inspect", mcpAllowed: true },
        { id: "fixture:mutate", summary: "External mutation", mcpAllowed: true },
      ],
    },
  };
  await writeFile(join(path, "package.json"), JSON.stringify({ landoPlugin: manifest }));
  await writeFile(
    join(root, ".lando/plugins/registry.json"),
    JSON.stringify({
      [manifest.name]: { name: manifest.name, version: manifest.version, path },
    }),
  );
  await writeFile(
    join(path, "index.ts"),
    `import { Effect, Schema } from "effect";
export const commands = new Map(${JSON.stringify(manifest.contributes.commands)}.map(({ id }) => [id, async () => ({
  id, namespace: id.split(":")[0], bootstrap: "app", resultSchema: Schema.String,
  ...(id === "fixture:mutate" ? { flags: { yes: { type: "boolean" } } } : {}),
  run: () => Effect.succeed("fixture"),
})]));`,
  );
});
afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test.each([
  { flags: [], listed: [] },
  { flags: ["--allow", "fixture:inspect"], listed: ["fixture:inspect"] },
  { flags: ["--allow", "fixture:mutate"], listed: ["fixture:mutate"] },
  { flags: ["--allow", "fixture:inspect", "--deny", "fixture:inspect"], listed: [] },
])("source --list honors external eligibility and deny for $flags", async ({ flags, listed }) => {
  const child = Bun.spawn([process.execPath, cli, "mcp", "--list", "--format", "json", ...flags], {
    cwd: root,
    env: {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  const envelope = Schema.decodeUnknownSync(
    Schema.Struct({ ok: Schema.Literal(true), result: McpListResultSchema }),
  )(JSON.parse(stdout));
  const plugins = envelope.result.tools.filter((tool) => tool.plugin !== undefined);
  expect(plugins.map((tool) => tool.id)).toEqual([...listed]);
  expect(envelope.result.tools.some((tool) => tool.id === "db:snapshots")).toBe(false);
  expect(envelope.result.diagnostics).toContainEqual(
    expect.objectContaining({ _tag: "McpAllowlistConflictError" }),
  );
  // The app-local replacement stays external for authorization but keeps its discovery tier.
  for (const tool of plugins)
    expect(tool.plugin).toEqual({ name: "@lando/sql", source: "external", provenance: "app" });
});
