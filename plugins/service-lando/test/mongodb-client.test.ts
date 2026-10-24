import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { mongodbServiceType } from "../src/services/mongodb.ts";

const resolve = () =>
  Effect.runPromise(
    mongodbServiceType.resolve({
      name: "db",
      appRoot: "/srv/myapp",
      metadata: { resolvedAt: "2026-10-23T00:00:00Z", source: "/srv/myapp/.lando.yml", runtime: 4 },
      service: Schema.decodeUnknownSync(ServiceConfig)({
        type: "mongodb",
        creds: { user: "a!'()* /é", password: "p!'()* /é", database: "d/?" },
      }),
    }),
  );

test("MongoDB encodes literal URI components with canonical RFC3986 encoding", async () => {
  const resolution = await resolve();
  expect(resolution.tooling?.mongosh?.env?.MONGO_URI).toBe(
    "mongodb://a%21%27%28%29%2A%20%2F%C3%A9:p%21%27%28%29%2A%20%2F%C3%A9@127.0.0.1:27017/d%2F%3F?authSource=admin",
  );
});

test.each([
  { args: [], shell: true },
  { args: ["--eval", "db.getName()"], shell: false },
  { args: ["--eval=db.getName()"], shell: false },
  { args: ["--json", "--eval", "db.getName()"], shell: false },
  { args: ["--shell", "--eval", "db.getName()"], shell: true },
  { args: ["seed.js"], shell: false },
  { args: ["--file", "seed.js"], shell: false },
  { args: ["--quiet"], shell: true },
])("generated mongosh wrapper preserves user arguments $args and shell behavior", async ({ args, shell }) => {
  const resolution = await resolve();
  const command = resolution.tooling?.mongosh?.cmd;
  if (!Array.isArray(command)) throw new Error("expected generated argv");
  const directory = await mkdtemp(join(tmpdir(), "lando-mongosh-client-"));
  try {
    const executable = join(directory, "mongosh");
    await Bun.write(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),uri:process.env.MONGO_URI}));\n`,
    );
    await chmod(executable, 0o700);
    const result = Bun.spawnSync([...command, ...args], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MONGO_URI: "private-runtime-uri" },
    });
    expect(result.exitCode).toBe(0);
    const output: unknown = JSON.parse(result.stdout.toString());
    expect(output).toEqual({
      args: [
        "--nodb",
        "--eval",
        "db=connect(process.env.MONGO_URI)",
        ...(shell && !args.some((arg) => arg === "--shell") ? ["--shell"] : []),
        ...args,
      ],
      uri: "private-runtime-uri",
    });
    expect(result.stdout.toString()).not.toContain('--json","--shell');
    expect(JSON.stringify(command)).not.toContain("private-runtime-uri");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
