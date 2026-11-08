import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Schema } from "effect";
import { mongodbProbes } from "../src/services/mongodb-probes.ts";

test.skipIf(process.platform === "win32").each([
  { clientExit: 0, ok: 1, exit: 0 },
  { clientExit: 0, ok: 0, exit: 1 },
  { clientExit: 33, ok: 1, exit: 33 },
])("distinguishes a real listener from protocol status $exit", async (input) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mongo-probe-"));
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  });
  try {
    const client = join(root, "mongosh");
    await Bun.write(
      client,
      `#!${process.execPath}
const args = process.argv.slice(2);
console.log(JSON.stringify({ args, home: process.env.HOME, mode: require("node:fs").statSync(process.env.HOME).mode & 0o777 }));
if (Number(process.env.CLIENT_EXIT)) process.exit(Number(process.env.CLIENT_EXIT));
new Function("db", "quit", args[args.indexOf("--eval") + 1])(
  { adminCommand: () => ({ ok: Number(process.env.PING_OK) }) }, (code) => process.exit(code));
`,
    );
    await chmod(client, 0o755);
    const probes = mongodbProbes(server.port);
    const command = probes.readiness.command;
    if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
    const child = Bun.spawn([...command], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        LANDO_PROBE_HOST: "127.0.0.1",
        LANDO_PROBE_PORT: String(server.port),
        CLIENT_EXIT: String(input.clientExit),
        PING_OK: String(input.ok),
        HOME: "/authored-home",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: input.exit, stderr: "" });
    const observed = Schema.decodeUnknownSync(
      Schema.Struct({ args: Schema.Array(Schema.String), home: Schema.String, mode: Schema.Number }),
    )(JSON.parse(stdout));
    expect(observed.args).toContain(
      `mongodb://127.0.0.1:${server.port}/admin?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&socketTimeoutMS=2000`,
    );
    expect(observed.args).toContain("--norc");
    expect(observed.home).not.toBe("/authored-home");
    expect(observed.mode).toBe(0o700);
    expect(await readdir(dirname(observed.home))).not.toContain(basename(observed.home));
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "does not launch mongosh when the listener is unavailable",
  async () => {
    const command = mongodbProbes(1).readiness.command;
    if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
    const child = Bun.spawn([...command], {
      env: { ...process.env, LANDO_PROBE_HOST: "127.0.0.1", LANDO_PROBE_PORT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(1);
    expect(stderr.trim()).toBe("Lando's TCP probe could not connect to 127.0.0.1:1");
  },
);

test.skipIf(process.platform === "win32")(
  "ongoing health succeeds without a Mongo client or shell state",
  async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
        open(socket) {
          socket.end();
        },
      },
    });
    try {
      const command = mongodbProbes(server.port).healthcheck.command;
      if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
      const child = Bun.spawn([...command], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent-probe-home",
          LANDO_PROBE_HOST: "127.0.0.1",
          LANDO_PROBE_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe("");
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      server.stop(true);
    }
  },
);
