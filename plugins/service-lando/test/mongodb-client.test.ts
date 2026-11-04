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
  if (command === undefined || typeof command === "string") throw new Error("expected generated argv");
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
    const output = Schema.decodeUnknownSync(
      Schema.Struct({ args: Schema.Array(Schema.String), uri: Schema.String }),
    )(JSON.parse(result.stdout.toString()));
    expect(output.args.slice(0, 2)).toEqual(["--nodb", "--eval"]);
    expect(output.args.slice(3)).toEqual([
      ...(shell && !args.some((arg) => arg === "--shell") ? ["--shell"] : []),
      ...args,
    ]);
    expect(output.uri).toBe("private-runtime-uri");
    expect(result.stdout.toString()).not.toContain('--json","--shell');
    expect(JSON.stringify(command)).not.toContain("private-runtime-uri");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([
  { errorCode: 18, expectedExit: 23, recovery: true },
  { errorCode: 2, expectedExit: 23, recovery: false },
  { errorCode: 0, expectedExit: 27, recovery: false },
])("preserves generated-client exit semantics with connection code $errorCode", async (input) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mongo-client-"));
  try {
    const executable = join(root, "mongosh");
    await Bun.write(
      executable,
      `#!${process.execPath}
const args = process.argv.slice(2);
console.log(JSON.stringify(args));
const expressions = args.flatMap((arg, index) => arg === "--eval" ? [args[index + 1]] : []);
try {
  await new Function("connect", "return eval(" + JSON.stringify(expressions[0]) + ");")(async () => {
    if (Number(process.env.TEST_ERROR_CODE)) throw Object.assign(new Error("connection rejected"), { code: Number(process.env.TEST_ERROR_CODE) });
    return {};
  });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(JSON.stringify({ code: error.code, message: error.message }));
  process.exit(23);
}
new Function("quit", expressions[1])((code) => process.exit(code));
`,
    );
    await chmod(executable, 0o755);
    const resolution = await Effect.runPromise(
      mongodbServiceType.resolve({
        name: "db",
        appRoot: root,
        appName: "client",
        service: Schema.decodeUnknownSync(ServiceConfig)({
          type: "mongodb",
          creds: { user: "client-user", password: "client-secret", database: "client" },
        }),
        metadata: { resolvedAt: "2026-10-01T00:00:00Z", source: "test", runtime: 4 },
      }),
    );
    const tooling = resolution.tooling?.mongosh;
    const command = tooling?.cmd;
    const uri = tooling?.env?.MONGO_URI;
    if (command === undefined || typeof command === "string" || typeof uri !== "string")
      throw new Error("Expected Mongo client argv and literal URI");
    const child = Bun.spawn([...command, "--eval", "quit(27)"], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        MONGO_URI: uri,
        TEST_ERROR_CODE: String(input.errorCode),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(input.expectedExit);
    if (input.errorCode === 0) {
      expect(stderr).toBe("");
    } else {
      const failure = Schema.decodeUnknownSync(
        Schema.Struct({ code: Schema.Number, message: Schema.String }),
      )(JSON.parse(stderr));
      expect(failure.code).toBe(input.errorCode);
      expect(failure.message === "connection rejected").toBe(!input.recovery);
    }
    const argv = Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(stdout));
    expect(argv.at(-1)).toBe("quit(27)");
    expect(stdout).not.toContain("client-secret");
    expect(stderr).not.toContain("client-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
