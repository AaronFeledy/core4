import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { InitAppResultSchema } from "../../src/cli/commands/recipe-init-schemas";
import { initAppWithOwnerOnlyFileAccess } from "../_support/private-file-access";

test("fully supplied init answers never invoke the review consumer", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-review-supplied-"));
  let reviews = 0;
  try {
    const result = await initAppWithOwnerOnlyFileAccess({
      cwd: root,
      destination: join(root, "project"),
      recipe: "node-postgres",
      name: "supplied-app",
      full: false,
      nonInteractive: false,
      runPostInit: false,
      userDataRoot: join(root, "data"),
      onPrepared: async () => {
        reviews++;
      },
    });
    expect(reviews).toBe(0);
    expect(result.receipt.created).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([{ flags: [] }, { flags: ["--yes"] }, { flags: ["--no-interactive"] }])(
  "native init retains its machine schema with explicit --interactive and %j",
  async ({ flags }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-init-review-native-"));
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          resolve(import.meta.dirname, "../../bin/lando.ts"),
          "init",
          "project",
          "--recipe=node-postgres",
          "--interactive",
          "--format=json",
          ...flags,
        ],
        cwd: root,
        env: {
          ...process.env,
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "plugins"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout));
      expect(code).toBe(0);
      expect(envelope.ok).toBe(true);
      const result = Schema.decodeUnknownSync(InitAppResultSchema)(envelope.result, {
        onExcessProperty: "error",
      });
      expect(result.directory).toBe(join(root, "project"));
      expect(result.receipt.created.map(({ path }) => path).sort()).toEqual(
        [".lando.yml", "package.json", "server.js"].sort(),
      );
      expect(stderr).not.toContain("\u001b[");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
