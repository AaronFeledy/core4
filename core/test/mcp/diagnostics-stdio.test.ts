import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { McpDiagnostics } from "@lando/mcp/service";
import { Schema } from "effect";
import { fixtureRoot, writeFixtureApp } from "./app-fixture";
import { openStdioSession } from "./stdio-session";

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
test("stdio diagnostics bound authorized records using captured invocation secrets and keep CLI list consistent", async () => {
  const root = await fixtureRoot("diagnostics-bounds");
  const secret = "captured-private-value-7319";
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
    `export const commands = new Map(${JSON.stringify([...ids, denied])}.map(id => [id, async () => { throw new Error("Lazy command failed"); }]));`,
  );
  const env = {
    ...process.env,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
    SESSION_API_TOKEN: undefined,
    PATH: "/no-such-path",
    LANDO_PROVIDER: "podman",
  };
  const invocationEnv = JSON.stringify({ ...env, SESSION_API_TOKEN: secret });
  const command = [process.execPath, resolve(import.meta.dir, "captured-environment-cli.ts"), invocationEnv];
  const flags = [...ids, denied].flatMap((id) => ["--allow", id]).concat(["--deny", denied]);
  const session = openStdioSession({ command: [...command, "mcp", ...flags], cwd: app.root, env });
  try {
    await session.initialize();
    const response = await session.request("resources/read", { uri: "lando://diagnostics" });
    const result = payload(response);
    expect(result.diagnostics.length + result.omittedDiagnosticCount).toBe(12);
    expect(result.omittedDiagnosticCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(denied);
    expect(result.diagnostics.every((record) => record.commandId.includes("[redacted]"))).toBe(true);
    expect(result.diagnostics.every((record) => record.message.includes("[redacted]"))).toBe(true);
    expect(result.diagnostics.every((record) => record.remediation?.includes("[redacted]"))).toBe(true);
    expect(tools(await session.request("tools/list")).filter((id) => id.startsWith("fixture:"))).toEqual([]);
    const listed = Bun.spawn([...command, "mcp", "--list", "--format=json", ...flags], {
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
    expect(stdout).not.toContain(secret);
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
