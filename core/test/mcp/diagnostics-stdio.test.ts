import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpDiagnostics } from "@lando/mcp/service";
import { Schema } from "effect";
import { fixtureRoot, lazyCommandSource, writeFixtureApp } from "./app-fixture";
import { openStdioSession } from "./stdio-session";

const cli = resolve(import.meta.dir, "../../bin/lando.ts");
const tools = (message: Schema.JsonObject) =>
  Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) }),
  )(message).result.tools.map((tool) => tool.name);
const payload = (message: Schema.JsonObject) => {
  const { result } = Schema.decodeUnknownSync(
    Schema.Struct({
      result: Schema.Struct({
        contents: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  )(message);
  return Schema.decodeUnknownSync(McpDiagnostics)(JSON.parse(result.contents[0]?.text ?? "null"));
};
const landofile = (broken: boolean) => `name: diagnostics
includes:
  - source: ./internal.yml
    kind: tooling
    namespace: private
    internal: true
tooling:
  healthy:
    service: ":host"
    cmd: echo healthy
  broken:
    service: ":host"
    ${broken ? "wrapper: true\n    cmds:\n      - echo one\n      - echo two" : "cmd: echo repaired"}
  denied:
    wrapper: true
  disabled:
    disabled: true
    wrapper: true
`;

test("diagnostics resource refreshes tooling and selected plugin failures with the published tools in one stdio session", async () => {
  const root = await fixtureRoot("diagnostics-stdio");
  const app = await writeFixtureApp(root, "a", {
    commands: [],
    serviceType: "diagnostics-type",
    lazyCommand: "fixture:broken",
  });
  await writeFile(join(app.root, ".lando.yml"), landofile(true));
  await writeFile(join(app.root, "internal.yml"), "tooling:\n  private:\n    wrapper: true\n");
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
    LANDO_PROVIDER: "lando",
    PATH: "/no-such-path",
  };
  const session = openStdioSession({
    command: [process.execPath, cli, "mcp", "--tooling", "--allow", "fixture:broken", "--deny", "app:denied"],
    cwd: app.root,
    env,
  });
  try {
    await session.initialize();
    const discovered = await session.request("resources/list");
    expect(discovered.result).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({
          uri: "lando://diagnostics",
          description: expect.stringContaining("session"),
        }),
      ]),
    });
    const read = () => session.request("resources/read", { uri: "lando://diagnostics" }).then(payload);
    const initial = await read();
    expect(initial.diagnostics.map((record) => record.commandId).sort()).toEqual([
      "app:broken",
      "fixture:broken",
    ]);
    expect(initial.diagnostics.find((record) => record.commandId === "app:broken")).toMatchObject({
      kind: "tooling",
      sourceKind: "landofile",
      _tag: "ToolingCompileError",
    });
    expect(initial.omittedDiagnosticCount).toBe(0);
    expect(
      tools(await session.request("tools/list")).filter(
        (id) => id === "app:healthy" || id === "app:broken" || id.startsWith("fixture:"),
      ),
    ).toEqual(["app:healthy"]);

    await writeFile(join(app.root, ".lando.yml"), landofile(false));
    const changed = session.waitFor((message) => message.method === "notifications/tools/list_changed");
    const repaired = await read();
    await changed;
    expect(repaired.diagnostics.map((record) => record.commandId)).toEqual(["fixture:broken"]);
    expect(repaired.revision).toBeGreaterThan(initial.revision);
    expect(tools(await session.request("tools/list"))).toContain("app:broken");
    await writeFile(app.lazyModule, lazyCommandSource("fixture:broken"));
    expect((await read()).diagnostics).toEqual([]);
    expect(
      (await session.request("tools/call", { name: "fixture:broken", arguments: {} })).result,
    ).toMatchObject({ structuredContent: { ok: true } });
    expect((await session.request("tools/call", { name: "app:broken", arguments: {} })).result).toMatchObject(
      { structuredContent: { ok: true } },
    );

    await writeFile(join(app.root, ".lando.yml"), landofile(true));
    const hidden = session.waitFor((message) => message.method === "notifications/tools/list_changed");
    const regressed = await read();
    await hidden;
    expect(regressed.diagnostics.map((record) => record.commandId)).toEqual(["app:broken"]);
    expect(tools(await session.request("tools/list"))).not.toContain("app:broken");
    expect(await session.request("tools/call", { name: "app:broken", arguments: {} })).toHaveProperty(
      "error",
    );
    const finished = await session.finish();
    expect(finished.exit, finished.stderr).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("stdio diagnostics bound authorized records after redaction and keep CLI list consistent", async () => {
  const root = await fixtureRoot("diagnostics-bounds");
  const secret = "fixture-sensitive-token";
  const ids = Array.from({ length: 12 }, (_, index) => `fixture:${secret}-${"x".repeat(800)}-${index}`);
  const denied = "fixture:denied-source-metadata";
  const app = await writeFixtureApp(root, "bounds", {
    commands: [...ids, denied],
    serviceType: "bounds-type",
  });
  await writeFile(
    join(dirname(app.entry), "package.json"),
    JSON.stringify({
      landoPlugin: {
        name: "@example/app-bounds",
        version: "1.0.0",
        api: 4,
        entry: "index.ts",
        contributes: { commands: [...ids, denied].map((id) => ({ id, summary: "Unavailable fixture" })) },
      },
    }),
  );
  await writeFile(
    app.entry,
    `export const commands = new Map(${JSON.stringify([...ids, denied])}.map(id => [id, async () => undefined]));`,
  );
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
    DIAGNOSTICS_API_TOKEN: secret,
    PATH: "/no-such-path",
    LANDO_PROVIDER: "podman",
  };
  const flags = [...ids, denied].flatMap((id) => ["--allow", id]).concat(["--deny", denied]);
  const session = openStdioSession({ command: [process.execPath, cli, "mcp", ...flags], cwd: app.root, env });
  try {
    await session.initialize();
    const response = await session.request("resources/read", { uri: "lando://diagnostics" });
    const result = payload(response);
    expect(result.diagnostics.length + result.omittedDiagnosticCount).toBe(12);
    expect(result.omittedDiagnosticCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(denied);
    expect(result.diagnostics.every((record) => record.commandId.includes("[redacted]"))).toBe(true);
    expect(tools(await session.request("tools/list")).filter((id) => id.startsWith("fixture:"))).toEqual([]);
    const listed = Bun.spawn([process.execPath, cli, "mcp", "--list", "--format=json", ...flags], {
      cwd: app.root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(listed.stdout).text(),
      new Response(listed.stderr).text(),
      listed.exited,
    ]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      result: { diagnostics: result.diagnostics, omittedDiagnosticCount: result.omittedDiagnosticCount },
    });
    expect((await session.finish()).exit).toBe(0);
  } finally {
    session.child.kill();
    await session.child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
