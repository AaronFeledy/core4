import { afterAll, beforeAll, expect, test } from "bun:test";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Predicate, Schema } from "effect";

import { McpListResultSchema } from "../../src/cli/commands/meta/mcp-list";
import { type FixtureApp, fixtureRoot, writeFixtureApp } from "./app-fixture";
import { openStdioSession as openSession } from "./stdio-session";

const cli = resolve(import.meta.dir, "../../bin/lando.ts");
let parent: string;
let a: FixtureApp;
let b: FixtureApp;

beforeAll(async () => {
  parent = await fixtureRoot("generations-stdio");
  a = await writeFixtureApp(parent, "a", { commands: ["fixture:shared"], serviceType: "a-thing" });
  b = await writeFixtureApp(parent, "b", {
    commands: ["fixture:shared", "fixture:b-only"],
    serviceType: "b-thing",
  });
});
afterAll(async () => {
  if (parent !== undefined) await rm(parent, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  LANDO_USER_DATA_ROOT: join(parent, "data"),
  LANDO_USER_CACHE_ROOT: join(parent, "cache"),
  LANDO_USER_CONF_ROOT: join(parent, "conf"),
  LANDO_PROVIDER: "podman",
  PATH: "/no-such-path",
});

const allowFlags = ["--allow", "fixture:shared", "--allow", "fixture:b-only"];

const toolNames = (message: Schema.JsonObject): ReadonlyArray<string> => {
  const result = message.result;
  const tools = Predicate.isObject(result) && Array.isArray(result.tools) ? result.tools : [];
  return tools
    .flatMap((tool) => (Predicate.isObject(tool) && typeof tool.name === "string" ? [tool.name] : []))
    .filter((name) => name.startsWith("fixture:"));
};

const structured = (message: Schema.JsonObject): unknown => {
  const result = message.result;
  return Predicate.isObject(result) ? result.structuredContent : undefined;
};

const openStdioSession = (cwd: string, flags: ReadonlyArray<string>) => {
  return openSession({ command: [process.execPath, cli, "mcp", ...flags], cwd, env: env() });
};

test("a call targeting another app registers that app's tools over real stdio and announces list_changed", async () => {
  // Given `lando mcp` served from app A, allowing an id only app B defines
  const session = openStdioSession(a.root, allowFlags);
  try {
    const initialized = await session.initialize();
    const before = await session.request("tools/list");

    // When a default tool is called with appPath pointing at app B
    const announcement = session.waitFor((message) => message.method === "notifications/tools/list_changed");
    const [viewB, changed] = await Promise.all([
      session.request("tools/call", {
        name: "app:config:view",
        arguments: { appPath: b.root },
      }),
      announcement,
    ]);
    const after = await session.request("tools/list");
    const bOnly = await session.request("tools/call", {
      name: "fixture:b-only",
      arguments: { appPath: "../b" },
    });
    const { exit, stderr } = await session.finish();

    // Then the session declared listChanged, announced the change, and serves B's tool from B
    expect(initialized.result).toMatchObject({ capabilities: { tools: { listChanged: true } } });
    expect(toolNames(before)).toEqual(["fixture:shared"]);
    expect(structured(viewB)).toMatchObject({ ok: true });
    expect(changed.method).toBe("notifications/tools/list_changed");
    expect([...toolNames(after)].sort()).toEqual(["fixture:b-only", "fixture:shared"]);
    expect(structured(bOnly)).toMatchObject({ ok: true, result: { app: "b", id: "fixture:b-only" } });
    expect(exit, stderr).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
  }
}, 60_000);

test("each call rediscovers its app root, so a Landofile created mid-session selects the nearer app", async () => {
  // Given a directory inside app A whose own app (with its own plugin) has no Landofile yet
  const nested = await writeFixtureApp(a.root, "nested", {
    commands: ["fixture:nested-only"],
    serviceType: "nested-thing",
  });
  const landofile = join(nested.root, ".lando.yml");
  const hidden = join(nested.root, "landofile.hidden");
  await rename(landofile, hidden);
  const session = openStdioSession(a.root, ["--allow", "fixture:nested-only"]);
  try {
    await session.initialize();
    const view = { name: "app:config:view", arguments: { appPath: nested.root } };
    const first = await session.request("tools/call", view);

    // When the nearer Landofile appears and the next call targets the same directory
    await rename(hidden, landofile);
    const second = await session.request("tools/call", view);
    const listed = await session.request("tools/list");
    const nestedOnly = await session.request("tools/call", {
      name: "fixture:nested-only",
      arguments: { appPath: nested.root },
    });
    const { exit, stderr } = await session.finish();

    // Then the second call selected the nested app and its plugin tool runs from it
    expect(structured(first)).toMatchObject({ ok: true, result: { app: "app-a" } });
    expect(structured(second)).toMatchObject({ ok: true, result: { app: "app-nested" } });
    expect(toolNames(listed)).toContain("fixture:nested-only");
    expect(structured(nestedOnly)).toMatchObject({
      ok: true,
      result: { app: "nested", id: "fixture:nested-only" },
    });
    expect(exit, stderr).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
    await rm(nested.root, { recursive: true, force: true });
  }
}, 60_000);

test("--list reports the session app's plugin tools and an unresolved allowance as a pending diagnostic", async () => {
  // Given app A, whose plugins do not define fixture:b-only
  const child = Bun.spawn([process.execPath, cli, "mcp", "--list", "--format", "json", ...allowFlags], {
    cwd: a.root,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });

  // When the catalog is listed
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  // Then A's own plugin tool is listed and the other allowance stays pending
  expect(exit, stderr).toBe(0);
  const envelope = Schema.decodeUnknownSync(
    Schema.Struct({ ok: Schema.Literal(true), result: McpListResultSchema }),
  )(JSON.parse(stdout));
  expect(
    envelope.result.tools.filter((tool) => tool.plugin?.source === "external").map((tool) => tool.id),
  ).toEqual(["fixture:shared"]);
  expect(envelope.result.diagnostics).toContainEqual(
    expect.objectContaining({
      _tag: "McpPendingAllowance",
      message: expect.stringContaining("fixture:b-only"),
    }),
  );
}, 30_000);

test("real MCP calls reload transitive edits and recover from syntax errors without restarting", async () => {
  const app = await writeFixtureApp(parent, "reload", {
    commands: ["fixture:shared"],
    serviceType: "reload-thing",
  });
  const value = join(dirname(app.entry), "value.ts");
  await writeFile(value, 'export const version = "before";');
  await writeFile(
    app.entry,
    `import { version } from "./value.ts";\n${(await Bun.file(app.entry).text()).replace('app: "reload"', "app: version")}`,
  );
  const session = openStdioSession(app.root, ["--allow", "fixture:shared"]);
  try {
    await session.initialize();
    const call = () => session.request("tools/call", { name: "fixture:shared", arguments: {} });
    expect(structured(await call())).toMatchObject({ ok: true, result: { app: "before" } });
    await writeFile(value, 'export const version = "after";');
    expect(structured(await call())).toMatchObject({ ok: true, result: { app: "after" } });
    await writeFile(value, "export const version = ;");
    expect(structured(await call())).toMatchObject({ ok: false, error: { _tag: "PluginLoadError" } });
    await writeFile(value, 'export const version = "fixed";');
    await session.request("resources/read", { uri: "lando://diagnostics" });
    expect(structured(await call())).toMatchObject({ ok: true, result: { app: "fixed" } });
    const { exit, stderr } = await session.finish();
    expect(exit, stderr).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
    await rm(app.root, { recursive: true, force: true });
  }
}, 60_000);

test("a plugin that fails to import fails only its own tools, and recovers once its file is fixed", async () => {
  // Given app "pair" selecting two healthy plugins, each contributing one advertised tool
  const app = await writeFixtureApp(parent, "pair", {
    commands: ["fixture:pair-a"],
    serviceType: "pair-a-thing",
  });
  const other = await writeFixtureApp(join(parent, "pair-plugins"), "pairb", {
    commands: ["fixture:pair-b"],
    serviceType: "pair-b-thing",
  });
  const registry = { ...(await Bun.file(app.registry).json()), ...(await Bun.file(other.registry).json()) };
  await writeFile(app.registry, JSON.stringify(registry));
  const source = await Bun.file(other.entry).text();
  const session = openStdioSession(app.root, ["--allow", "fixture:pair-a", "--allow", "fixture:pair-b"]);
  try {
    await session.initialize();
    const call = (name: string) => session.request("tools/call", { name, arguments: {} });
    const before = await call("fixture:pair-b");

    // When the second plugin's entry gains a syntax error and every kind of tool is called
    await writeFile(other.entry, "export const commands = ;");
    const healthy = await call("fixture:pair-a");
    const builtIn = await call("app:config:view");
    const failed = await call("fixture:pair-b");
    expect(failed).toMatchObject({ error: { message: expect.stringContaining("fixture:pair-b") } });
    const diagnostics = await session.request("resources/read", { uri: "lando://diagnostics" });
    // And the entry is fixed before the next call
    await writeFile(other.entry, source);
    await session.request("resources/read", { uri: "lando://diagnostics" });
    const recovered = await call("fixture:pair-b");
    const { exit, stderr } = await session.finish();

    // Then only the broken plugin's tool failed, naming that plugin and its import error
    expect(structured(before)).toMatchObject({ ok: true, result: { app: "pairb", id: "fixture:pair-b" } });
    expect(structured(healthy)).toMatchObject({ ok: true, result: { app: "pair", id: "fixture:pair-a" } });
    expect(structured(builtIn)).toMatchObject({ ok: true, result: { app: "app-pair" } });
    const diagnosticPayload = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          contents: Schema.Array(Schema.Struct({ text: Schema.String })),
        }),
      }),
    )(diagnostics);
    expect(JSON.parse(diagnosticPayload.result.contents[0]?.text ?? "null")).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          commandId: "fixture:pair-b",
          _tag: "PluginLoadError",
          plugin: { name: "@example/app-pairb", source: "external", provenance: "app" },
        }),
      ],
    });
    expect(structured(recovered)).toMatchObject({ ok: true, result: { app: "pairb", id: "fixture:pair-b" } });
    expect(exit, stderr).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
    await rm(app.root, { recursive: true, force: true });
    await rm(join(parent, "pair-plugins"), { recursive: true, force: true });
  }
}, 60_000);
