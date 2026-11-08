import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { ensureCompiledCli } from "../_support/compiled-cli";
import { withEnvVar } from "../_support/temp-cwd";
import { stubContainerHelperDir } from "../build/fixtures/container-helper-stubs";
import { fixtureRoot, writeFixtureApp } from "./app-fixture";
import { openStdioSession } from "./stdio-session";

const callResult = Schema.decodeUnknownSync(
  Schema.Struct({
    isError: Schema.Boolean,
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    structuredContent: CommandResultEnvelope,
  }),
);
const toolNames = (message: Schema.JsonObject) =>
  Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }))(
    message.result,
  )
    .tools.map((tool) => tool.name)
    .filter((name) => name.startsWith("fixture:"));

test("#1750 compiled MCP plans another app with its service type and advertises its tools", async () => {
  const parent = await fixtureRoot("generations-compiled");
  const helpers = await stubContainerHelperDir();
  try {
    const binary = await withEnvVar("LANDO_CONTAINER_HELPER_DIR", helpers, ensureCompiledCli);
    const a = await writeFixtureApp(parent, "a", { commands: ["fixture:shared"], serviceType: "a-thing" });
    const b = await writeFixtureApp(parent, "b", {
      commands: ["fixture:shared", "fixture:b-only"],
      serviceType: "b-thing",
    });
    const session = openStdioSession({
      command: [
        binary,
        "mcp",
        "--allow",
        "app:config:lint",
        "--allow",
        "fixture:shared",
        "--allow",
        "fixture:b-only",
      ],
      cwd: a.root,
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(parent, "data"),
        LANDO_USER_CACHE_ROOT: join(parent, "cache"),
        LANDO_USER_CONF_ROOT: join(parent, "conf"),
        LANDO_PROVIDER: "podman",
        PATH: "/no-such-path",
      },
    });
    try {
      await session.initialize();
      const before = await session.request("tools/list");
      expect(toolNames(before)).toEqual(["fixture:shared"]);

      const announcement = session.waitFor(
        (message) => message.method === "notifications/tools/list_changed",
      );
      const [planned] = await Promise.all([
        session.request("tools/call", { name: "app:config:lint", arguments: { appPath: "../b" } }),
        announcement,
      ]);
      const plan = callResult(planned.result);
      expect(plan.isError, JSON.stringify(plan.structuredContent)).toBe(false);
      expect(plan.structuredContent.ok).toBe(true);
      expect(plan.structuredContent.result, JSON.stringify(plan.structuredContent)).toMatchObject({
        valid: true,
      });
      expect(plan.content).toHaveLength(2);
      expect(JSON.parse(plan.content[0]?.text ?? "null")).toEqual(plan.structuredContent);
      expect(plan.content[1]?.text).toContain(b.root);
      expect(plan.content[1]?.text).toContain("fixture:b-only");
      expect(plan.content[1]?.text).toContain("fixture:shared");
      expect(toolNames(await session.request("tools/list")).sort()).toEqual([
        "fixture:b-only",
        "fixture:shared",
      ]);

      const bOnly = callResult(
        (
          await session.request("tools/call", {
            name: "fixture:b-only",
            arguments: { appPath: "../b" },
          })
        ).result,
      );
      expect(bOnly.structuredContent).toMatchObject({ ok: true, result: { app: "b", id: "fixture:b-only" } });
      expect(bOnly.content).toHaveLength(1);
      const shared = callResult((await session.request("tools/call", { name: "fixture:shared" })).result);
      expect(shared.structuredContent).toMatchObject({
        ok: true,
        result: { app: "a", id: "fixture:shared" },
      });
      const invalid = callResult(
        (
          await session.request("tools/call", {
            name: "fixture:shared",
            arguments: { appPath: 42 },
          })
        ).result,
      );
      expect(JSON.parse(invalid.content[0]?.text ?? "null")).toEqual(invalid.structuredContent);
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: {
          apiVersion: "v4",
          command: "fixture:shared",
          ok: false,
          error: { _tag: "McpToolInputError", path: "appPath" },
          warnings: [],
          deprecations: [],
        },
      });
      const { exit, stderr } = await session.finish();
      expect(exit, stderr).toBe(0);
    } finally {
      session.child.kill();
      await session.child.exited;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(helpers, { recursive: true, force: true });
  }
}, 240_000);
