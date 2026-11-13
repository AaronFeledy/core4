import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { AppRef } from "@lando/sdk/schema";
import { Cause, Effect, Schema } from "effect";
import { runCli } from "../../src/cli/index.ts";
import { processInvocationContext } from "../../src/runtime/invocation-context.ts";

const repo = resolve(import.meta.dirname, "../../..");
const cli = join(repo, "core/bin/lando.ts");

interface Fixture {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly invoke: (args: ReadonlyArray<string>) => Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly cleanup: () => Promise<void>;
}

const fixture = async (loadFailure = false): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-flag-ownership-"));
  const plugin = join(root, ".lando/plugins/fixture");
  await mkdir(plugin, { recursive: true });
  await writeFile(join(root, ".lando.yml"), "name: plugin-flags\n");
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({
      landoPlugin: {
        name: "@example/fixture",
        version: "1.0.0",
        api: 4,
        entry: "index.ts",
        description: "Fixture commands.",
        contributes: {
          commands: [
            { id: "fixture:run", summary: "Run a fixture command.", topLevelAlias: "frun" },
            { id: "fixture:show", summary: "Show one value." },
            { id: "fixture:opts", summary: "Inspect fixture flags.", topLevelAlias: "fopts" },
            { id: "fixture:bad", summary: "Declare a reserved flag incompatibly." },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(root, ".lando/plugins/registry.json"),
    JSON.stringify({
      "@example/fixture": { name: "@example/fixture", version: "1.0.0", path: plugin },
    }),
  );
  await writeFile(
    join(plugin, "index.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "imported.marker"))}, "imported");
${
  loadFailure
    ? 'throw new Error("fixture load failure");'
    : `import { Effect, Schema } from "effect";
export const commands = new Map([["fixture:run", async () => ({
  id: "fixture:run",
  namespace: "fixture",
  summary: "Run a fixture command.",
  bootstrap: "minimal",
  strict: false,
  args: { command: { type: "string", multiple: true } },
  resultSchema: Schema.String,
  run: (input: { args: { command?: readonly string[] } }) =>
    Effect.sync(() => {
      writeFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify(input.args.command ?? []));
      return "ok";
    }),
})], ["fixture:show", async () => ({
  id: "fixture:show",
  namespace: "fixture",
  summary: "Show one value.",
  bootstrap: "minimal",
  args: { value: { type: "string" } },
  resultSchema: Schema.String,
  run: (input: { args: { value?: string } }) =>
    Effect.sync(() => {
      writeFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify([input.args.value ?? ""]));
      return "ok";
    }),
})], ["fixture:opts", async () => ({
  id: "fixture:opts",
  namespace: "fixture",
  summary: "Inspect fixture flags.",
  bootstrap: "minimal",
  flags: {
    verbose: { type: "boolean" },
    renderer: { type: "string" },
    format: { type: "string" },
    help: { type: "boolean" },
  },
  resultSchema: Schema.String,
  run: (input: { flags: Record<string, unknown> }) =>
    Effect.sync(() => {
      writeFileSync(${JSON.stringify(join(root, "opts.json"))}, JSON.stringify(input.flags));
      return "ok";
    }),
})], ["fixture:bad", async () => ({
  id: "fixture:bad",
  namespace: "fixture",
  summary: "Declare a reserved flag incompatibly.",
  bootstrap: "minimal",
  flags: { json: { type: "option" } },
  resultSchema: Schema.String,
  run: () => Effect.succeed("ok"),
})]]);`
}`,
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CACHE_ROOT: join(root, "cache"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
  };
  return {
    root,
    env,
    invoke: async (args) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const argvFile = async (f: Fixture): Promise<ReadonlyArray<string>> =>
  Schema.decodeUnknownSync(Schema.Array(Schema.String))(await Bun.file(join(f.root, "argv.json")).json());

const imported = async (f: Fixture): Promise<boolean> => Bun.file(join(f.root, "imported.marker")).exists();

const Opts = Schema.Struct({
  verbose: Schema.optionalKey(Schema.Boolean),
  renderer: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Schema.String),
  help: Schema.optionalKey(Schema.Boolean),
});

const optsFile = async (f: Fixture): Promise<typeof Opts.Type> =>
  Schema.decodeUnknownSync(Opts)(await Bun.file(join(f.root, "opts.json")).json());

test("a plugin command owns its tail and receives exact argv", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["fixture:run", "ls", "--format=json", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(await argvFile(f)).toEqual(["ls", "--format=json", "--help"]);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a leading Lando format flag is Lando's while the plugin tail keeps its own", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["--format=json", "fixture:run", "ls", "--format=csv", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: "fixture:run" });
    expect(await argvFile(f)).toEqual(["ls", "--format=csv", "--help"]);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("--help before the plugin tail shows plugin help", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["fixture:run", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("[COMMAND...]");
    expect(await imported(f)).toBe(true);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an unknown prefix flag fails before the plugin runs", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["--format=json", "fixture:run", "--bogus", "ls"]);
    // Then
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "UnknownCliFlagError", flag: "--bogus" },
    });
    expect(await Bun.file(join(f.root, "argv.json")).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a plugin module is not loaded for --version", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["--version", "fixture:run"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("0.0.0");
    expect(await imported(f)).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a plugin module is not loaded when the lead selection already fails", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["--renderer=bogus", "--format=json", "fixture:run"]);
    // Then
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "RendererSelectionError" },
    });
    expect(await imported(f)).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a plugin load failure is reported even when followed by a Lando-sized flag", async () => {
  // Given
  const f = await fixture(true);
  try {
    // When
    const result = await f.invoke(["--format=json", "fixture:run", "--format=csv"]);
    // Then
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("fixture load failure") },
    });
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a plugin command reached through its alias owns the same tail", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["frun", "ls", "--format=json", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(await argvFile(f)).toEqual(["ls", "--format=json", "--help"]);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an aliased plugin that fails to load reports the failure, not help, for a tail --help", async () => {
  // Given
  const f = await fixture(true);
  try {
    // When
    const result = await f.invoke(["--format=json", "frun", "ls", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("fixture load failure") },
    });
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("Lando answers --version before a plugin tail the same way for an id and its alias", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const byId = await f.invoke(["fixture:run", "--version"]);
    const byAlias = await f.invoke(["frun", "--version"]);
    // Then
    expect(byId.code, byId.stderr).toBe(0);
    expect(byAlias.code, byAlias.stderr).toBe(0);
    expect(byAlias.stdout).toBe(byId.stdout);
    expect(await Bun.file(join(f.root, "argv.json")).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("help after -- goes to a plugin command that owns no tail", async () => {
  // Given
  const f = await fixture();
  try {
    // When
    const result = await f.invoke(["fixture:show", "--", "--help"]);
    // Then
    expect(result.code, result.stderr).toBe(0);
    expect(await argvFile(f)).toEqual(["--help"]);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("host-proxy admission denies a plugin command before its module loads", async () => {
  // Given
  const f = await fixture();
  try {
    const codes: number[] = [];
    const io = createBufferedRendererIO();
    const call = {
      operation: "runLando" as const,
      argv: ["fixture:run"],
      env: {},
      app: Schema.decodeUnknownSync(AppRef)({ kind: "user", id: "fixture", root: f.root }),
      mount: { containerRoot: f.root, hostRoot: f.root },
      cwd: f.root,
      callId: "fixture-call",
      depth: 0,
      callerService: "test",
    };
    // When
    await runCli({
      argv: ["fixture:run"],
      rootUrl: "",
      hostProxy: call,
      context: {
        ...processInvocationContext(),
        cwd: f.root,
        env: f.env,
        io,
        setExitCode: (code) => codes.push(code),
        serviceLayers: [],
      },
    });
    // Then
    expect(await imported(f)).toBe(false);
    expect(codes).toEqual([1]);
    expect(`${io.stdout()}${io.stderr()}`).toContain("HostProxyCommandNotAllowedError");
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an interrupted plugin graph acquisition propagates", async () => {
  // Given a catalog whose metadata acquisition never settles.
  const { createPluginCommandCatalog } = await import("../../src/cli/plugin-command-catalog.ts");
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const catalog = createPluginCommandCatalog(controller.signal, () =>
    Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
  );
  // When the invocation is interrupted.
  const pending = catalog.resolve("fixture:run");
  const outcome = pending.catch((cause: unknown) => cause);
  try {
    await Effect.runPromise(Effect.promise(() => started.promise).pipe(Effect.timeout("5 seconds")));
    controller.abort("SIGINT");
    // Then the cancellation reaches the caller instead of reading as "no owner".
    const cause = await Effect.runPromise(Effect.promise(() => outcome).pipe(Effect.timeout("5 seconds")));
    expect(Cause.isCause(cause) && Cause.hasInterruptsOnly(cause)).toBe(true);
  } finally {
    controller.abort();
  }
}, 15_000);

test("a plugin command receives an authored verbose flag after its name", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(["--format=json", "fixture:opts", "--verbose"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await optsFile(f)).verbose).toBe(true);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a leading Lando verbose flag stays Lando's for a plugin command", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(["--format=json", "--verbose", "fixture:opts"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await optsFile(f)).verbose).toBeUndefined();
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a plugin command receives an authored renderer flag after its name", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(["--format=json", "fixture:opts", "--renderer", "plain"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await optsFile(f)).renderer).toBe("plain");
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an authored format flag never claims Lando's --format", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(["--format=json", "fixture:opts", "--format=csv"]);
    expect(result.code, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { _tag: "RendererSelectionError" },
    });
    expect(await Bun.file(join(f.root, "opts.json")).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an authored help flag owns --help but not -h", async () => {
  const authored = await fixture();
  try {
    const result = await authored.invoke(["--format=json", "fixture:opts", "--help"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await optsFile(authored)).help).toBe(true);
  } finally {
    await authored.cleanup();
  }
  const lando = await fixture();
  try {
    const result = await lando.invoke(["fixture:opts", "-h"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(await Bun.file(join(lando.root, "opts.json")).exists()).toBe(false);
  } finally {
    await lando.cleanup();
  }
}, 30_000);

test("text and machine plugin help list authored flags", async () => {
  const text = await fixture();
  try {
    const result = await text.invoke(["fixture:opts", "-h"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("--verbose");
    expect(result.stdout).toContain("--renderer");
    expect(result.stdout).toContain("after `fopts`");
    expect(result.stdout).toContain("lando --renderer=<value> fopts");
  } finally {
    await text.cleanup();
  }
  const machine = await fixture();
  try {
    const result = await machine.invoke(["help", "fixture:opts", "--format=json"]);
    expect(result.code, result.stderr).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      result: {
        target: {
          input: { flags: ReadonlyArray<{ name: string }> };
          landoFlags: { afterName: string; commandOwned: ReadonlyArray<string> };
        };
      };
    };
    expect(envelope.result.target.input.flags.map((flag) => flag.name)).toEqual([
      "verbose",
      "renderer",
      "help",
    ]);
    expect(envelope.result.target.landoFlags.afterName).toBe("until-separator");
    expect(envelope.result.target.landoFlags.commandOwned).toContain("--verbose");
    expect(envelope.result.target.landoFlags.commandOwned).not.toContain("--format");
  } finally {
    await machine.cleanup();
  }
}, 30_000);

test("machine help marks a plugin tail command and an ordinary plugin command", async () => {
  const f = await fixture();
  try {
    const tail = await f.invoke(["help", "fixture:run", "--format=json"]);
    expect(tail.code, tail.stderr).toBe(0);
    expect(JSON.parse(tail.stdout).result.target.landoFlags).toEqual({
      afterName: "command-tail",
      commandOwned: [],
    });

    const plain = await f.invoke(["help", "fixture:show", "--format=json"]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout).result.target.landoFlags).toEqual({
      afterName: "until-separator",
      commandOwned: [],
    });
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("an incompatible reserved flag declaration fails the plugin load", async () => {
  const f = await fixture();
  try {
    const result = await f.invoke(["fixture:bad"]);
    expect(result.code, result.stderr).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("reserved flag");
    expect(`${result.stdout}\n${result.stderr}`).toContain("--format, --json, and -j");
  } finally {
    await f.cleanup();
  }
}, 30_000);
