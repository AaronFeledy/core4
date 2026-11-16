import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { McpListResultSchema } from "../../src/cli/commands/meta/mcp-list";
import { fixtureRoot, writeFixtureApp } from "./app-fixture";
import { openStdioSession } from "./stdio-session";

const runner = resolve(import.meta.dir, "captured-cwd-cli.ts");

test.each(["list", "stdio"])(
  "in-process MCP %s keeps session catalogs on the captured app despite another ambient app",
  async (mode) => {
    const root = await fixtureRoot("captured-cwd");
    try {
      const apps = await Promise.all(
        ["a", "b"].map(async (letter) => {
          const app = await writeFixtureApp(root, letter, {
            commands: [`fixture:${letter}`, "fixture:shared"],
            serviceType: `${letter}-type`,
          });
          await writeFile(
            join(app.root, ".lando.yml"),
            `name: app-${letter}\ntooling:\n  ${letter}:\n    service: ":host"\n    cmd: echo ${letter}\n  broken-${letter}:\n    wrapper: true\n`,
          );
          return app;
        }),
      );
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new TypeError("Missing fixture apps");
      const command = [
        process.execPath,
        runner,
        a.root,
        "mcp",
        "--tooling",
        "--allow=fixture:a",
        "--allow=fixture:b",
        "--allow=fixture:shared",
      ];
      const env = {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        PATH: "/no-such-path",
      };
      if (mode === "stdio") {
        const session = openStdioSession({ command, cwd: b.root, env });
        try {
          await session.initialize();
          const listed = await session.request("tools/list");
          const tools = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
            }),
          )(listed).result.tools;
          expect(
            tools
              .filter(
                (tool) =>
                  tool.name.startsWith("fixture:") ||
                  tool.name.startsWith("app:a") ||
                  tool.name.startsWith("app:b"),
              )
              .map((tool) => tool.name)
              .sort(),
          ).toEqual(["app:a", "fixture:a", "fixture:shared"]);
          expect(
            (await session.request("tools/call", { name: "fixture:shared", arguments: { appPath: b.root } }))
              .result,
          ).toMatchObject({
            structuredContent: { ok: false, error: { _tag: "McpToolInputError", path: "appPath" } },
          });
          await session.request("tools/list");
          expect(
            (await session.request("tools/call", { name: "fixture:b", arguments: { appPath: b.root } }))
              .result,
          ).toMatchObject({ structuredContent: { ok: true, result: { app: "b" } } });
          const response = await session.request("resources/read", { uri: "lando://diagnostics" });
          const contents = Schema.decodeUnknownSync(
            Schema.Struct({
              result: Schema.Struct({ contents: Schema.Array(Schema.Struct({ text: Schema.String })) }),
            }),
          )(response).result.contents;
          expect(
            JSON.parse(contents[0]?.text ?? "null").diagnostics.map(
              (record: { commandId: string }) => record.commandId,
            ),
          ).toEqual(["app:broken-a"]);
          expect((await session.finish()).exit).toBe(0);
        } finally {
          session.child.kill();
          await session.child.exited;
        }
        return;
      }
      const child = Bun.spawn([...command, "--list", "--format=json"], {
        cwd: b.root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit, stdout + stderr).toBe(0);
      const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: McpListResultSchema }))(
        JSON.parse(stdout),
      );
      expect(
        envelope.result.tools
          .filter((tool) => tool.source === "tooling" || tool.id.startsWith("fixture:"))
          .map((tool) => tool.id),
      ).toEqual(["app:a", "fixture:a", "fixture:shared"]);
      expect(envelope.result.diagnostics.map((record) => record.commandId)).toEqual(["app:broken-a"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
