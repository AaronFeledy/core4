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
