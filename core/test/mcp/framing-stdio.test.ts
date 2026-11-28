import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fixtureRoot } from "./app-fixture";
import { openStdioSession } from "./stdio-session";

const cli = resolve(import.meta.dir, "../../bin/lando.ts");

test("lando mcp ignores blank input and answers a ping after malformed JSON", async () => {
  const root = await fixtureRoot("framing-stdio");
  try {
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, ".lando.yml"), "name: framing\n");
    const session = openStdioSession({
      command: [process.execPath, cli, "mcp"],
      cwd: app,
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        LANDO_PROVIDER: "lando",
        PATH: "/no-such-path",
      },
    });
    try {
      await session.initialize();
      const parseError = session.waitFor((message) => message.id === null);
      const [, ping] = await Promise.all([
        parseError,
        session
          .sendRaw(' \t\r\n{"jsonrpc":"2.0","id":10,"method":"ping",}\n')
          .then(() => session.request("ping")),
      ]);
      expect(ping).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
      const { exit, stderr, messages } = await session.finish();
      expect(exit, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(messages.filter((message) => message.error !== undefined)).toEqual([
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      ]);
    } finally {
      session.child.kill();
      await session.child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25_000);
