import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { McpListResultSchema } from "../../src/cli/commands/meta/mcp-list";

const cli = resolve(import.meta.dir, "../../bin/lando.ts");

const landofile = (task: string) =>
  `name: mcp-rebuild\nservices:\n  web:\n    image: nginx:1\ntooling:\n  ${task}:\n    service: ":host"\n    cmd: echo ${task}\n`;

const run = async (root: string, argv: readonly string[], env: Readonly<Record<string, string>> = {}) => {
  const child = Bun.spawn([process.execPath, cli, ...argv], {
    cwd: root,
    env: {
      ...process.env,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CACHE_ROOT: join(root, "cache"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
};

test("session start rebuilds a stale index so an app with services gets its tooling catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-session-rebuild-"));
  try {
    // Given an app with services whose command index was built before a task was renamed
    await writeFile(join(root, ".lando.yml"), landofile("before"));
    const refresh = await run(root, ["app:cache:refresh", "--format=json"]);
    expect(refresh.exit, refresh.stderr).toBe(0);
    await writeFile(join(root, ".lando.yml"), landofile("after"));

    // When the MCP catalog is resolved with tooling projected
    const listed = await run(root, ["mcp", "--tooling", "--list", "--format=json"]);

    // Then the catalog reflects the edited Landofile
    expect(listed.exit, listed.stderr).toBe(0);
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ ok: Schema.Literal(true), result: McpListResultSchema }),
    )(JSON.parse(listed.stdout));
    const tooling = envelope.result.tools.filter((tool) => tool.source === "tooling").map((tool) => tool.id);
    expect(tooling).toEqual(["app:after"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("MCP catalog repairs cached environment failures without source edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-environment-rebuild-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: mcp-environment
tooling:
  deploy:
    service: ":host"
    cmd: echo deploying
    flags:
      target:
        choices: [dev, prod]
        default: "{{ env.TOOLING_CHOICE }}"
`,
    );
    expect((await run(root, ["app:cache:refresh", "--format=json"], { TOOLING_CHOICE: "bad" })).exit).toBe(0);
    const listed = await run(root, ["mcp", "--tooling", "--list", "--format=json"], {
      TOOLING_CHOICE: "dev",
    });
    expect(listed.exit, listed.stdout + listed.stderr).toBe(0);
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ ok: Schema.Literal(true), result: McpListResultSchema }),
    )(JSON.parse(listed.stdout));
    expect(envelope.result.tools.filter((tool) => tool.source === "tooling").map((tool) => tool.id)).toEqual([
      "app:deploy",
    ]);
    expect(envelope.result.diagnostics).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
