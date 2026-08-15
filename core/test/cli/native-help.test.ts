import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { unknownCommandError } from "../../src/cli/unknown-command-error.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type RunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
};

const runCli = async (argv: ReadonlyArray<string>, options: RunOptions = {}): Promise<RunResult> => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...argv],
    cwd: options.cwd ?? repoRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const makeAppFixture = async (): Promise<{
  readonly root: string;
  readonly cacheRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-native-help-"));
  const root = fixtureRoot;
  const cacheRoot = join(fixtureRoot, "cache");
  await writeFile(join(root, ".lando.yml"), "name: native-help\n");
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    root,
    cacheRoot,
    env: {
      ...inheritedEnv,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

const writeFreshCache = async (
  fixture: Awaited<ReturnType<typeof makeAppFixture>>,
  commandAliases?: {
    readonly enabled?: boolean;
    readonly disabled?: ReadonlyArray<string>;
    readonly custom?: Readonly<Record<string, string>>;
  },
): Promise<void> => {
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: { name: "native-help", ...(commandAliases === undefined ? {} : { commandAliases }) },
      entries: [{ id: "app:known", summary: "Known task", hidden: false, source: "bun-script" }],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
    }),
  );
};

const STACK_OR_SOURCE_PATH = /(^\s*at\s+\S+)|\/[A-Za-z0-9_.\-/]+\.(?:ts|js)(?:[:?]|\b)/m;

describe("native registry help", () => {
  test("Given app alias policy, when root help is requested, then active custom aliases replace disabled defaults", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      await writeFreshCache(fixture, {
        disabled: ["start"],
        custom: { hi: "app:known" },
      });

      // When
      const result = await runCli(["--help"], { cwd: fixture.root, env: fixture.env });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hi -> app:known");
      expect(result.stdout).not.toContain("start -> app:start");
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given the root registry, when help is requested, then registry summaries render without an OCLIF banner", async () => {
    // Given / When
    const result = await runCli(["--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("List Lando apps applied across discovered providers on this host.");
    expect(result.stdout).not.toContain("OCLIF adapter");
  });

  test("Given the root registry, when help is requested, then every visible canonical id and non-flag alias renders", async () => {
    // Given
    const visibleEntries = builtInCommandEntries.filter((entry) => entry.spec.hidden !== true);

    // When
    const result = await runCli(["--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("TOPICS");
    expect(result.stdout).toContain("COMMANDS");
    for (const entry of visibleEntries) {
      expect(result.stdout, `missing canonical id ${entry.spec.id}`).toContain(entry.spec.id);
      for (const alias of entry.command.aliases ?? []) {
        if (alias.startsWith("-")) continue;
        expect(result.stdout, `missing alias pointer ${alias} -> ${entry.spec.id}`).toContain(
          `${alias} -> ${entry.spec.id}`,
        );
      }
    }
  });

  test("Given a registered command, when its help is requested, then registry metadata and class-owned flags render", async () => {
    // Given / When
    const result = await runCli(["meta:plugin:login", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Authenticate with a plugin source.");
    expect(result.stdout).not.toContain("Authenticate with a private plugin registry.");
    expect(result.stdout).toContain("meta:plugin:login, plugin:login");
    expect(result.stdout).toContain("--registry");
  });

  test.each(["app:pull", "pull"] as const)(
    "Given the registered pull command form %s, when help is requested, then canonical registry help renders",
    async (command) => {
      // Given / When
      const result = await runCli([command, "--help"]);

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app:pull, pull");
    },
  );

  test("Given a deferred command, when help is requested, then its phase status renders successfully", async () => {
    // Given / When
    const result = await runCli(["plugin:login", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STATUS");
    expect(result.stdout).toContain("Planned for Lando 4.1.");
  });

  test("Given a bounded compatibility form, when help is requested, then it resolves to canonical command help", async () => {
    // Given / When
    const result = await runCli(["meta", "recipes", "list", "--help"]);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("meta:recipes:list");
  });
});

describe("native unknown-command failures", () => {
  test.each([
    ["plain unknown command", ["does-not-exist"]],
    ["unknown help target", ["does-not-exist", "--help"]],
    ["retired pull dispatcher alias", ["pull:app"]],
    ["retired share-list dispatcher alias", ["share:app:list"]],
    ["retired plugin trust dispatcher alias", ["plugin:trust-authoring-root"]],
    ["unsupported app space form", ["app", "unsupported"]],
    ["unsupported space form", ["apps", "list"]],
    ["unsupported meta space form", ["meta", "unsupported"]],
    ["unsupported global space form", ["global", "unsupported"]],
  ] as const)(
    "Given a %s, when dispatched, then a stack-free tagged failure is rendered",
    async (_name, argv) => {
      // Given / When
      const result = await runCli(argv);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("UnknownCommandError");
      expect(result.stderr).toContain(`Command ${argv[0]} not found`);
      expect(result.stderr).toContain("↳");
      expect(result.stderr).not.toMatch(STACK_OR_SOURCE_PATH);
    },
  );

  test("Given an app context and an unregistered share-list permutation, when dispatched, then dynamic tooling precedence is preserved", async () => {
    // Given
    const fixture = await makeAppFixture();
    try {
      await writeFreshCache(fixture);

      // When
      const result = await runCli(["app:list:share"], { cwd: fixture.root, env: fixture.env });

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ToolingCompileError");
      expect(result.stderr).not.toContain("UnknownCommandError");
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(["app", "apps", "meta", "global", "plugin"] as const)(
    "Given an app context, when unsupported %s namespace syntax is dispatched, then unknown-command handling wins over dynamic tooling",
    async (head) => {
      // Given
      const fixture = await makeAppFixture();
      try {
        await writeFreshCache(fixture);

        // When
        const result = await runCli([head, "unsupported"], { cwd: fixture.root, env: fixture.env });

        // Then
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("UnknownCommandError");
        expect(result.stderr).not.toContain("ToolingCompileError");
        expect(result.stderr).not.toMatch(STACK_OR_SOURCE_PATH);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("Given an app context and an unknown tooling token with terminal controls, when dispatched, then ToolingCompileError text is escaped", async () => {
    // Given
    const fixture = await makeAppFixture();
    const commandToken = "unknown-tooling\u001b[31m";
    try {
      await writeFreshCache(fixture);

      // When
      const result = await runCli([commandToken], { cwd: fixture.root, env: fixture.env });

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ToolingCompileError");
      expect(result.stderr).toContain("commandId: app:unknown-tooling\\u001b[31m");
      expect(result.stderr).not.toContain("\u001b");
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given an app context and an unknown tooling token with terminal controls, when JSON is requested, then the machine command stays raw without emitting raw controls", async () => {
    // Given
    const fixture = await makeAppFixture();
    const name = "unknown-tooling-json\u001b[31m";
    try {
      await writeFreshCache(fixture);

      // When
      const result = await runCli([name, "--format=json"], { cwd: fixture.root, env: fixture.env });
      const envelope: unknown = JSON.parse(result.stdout);

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("\u001b");
      expect(envelope).toMatchObject({
        command: `app:${name}`,
        ok: false,
        error: {
          _tag: "ToolingCompileError",
          message:
            "Tooling command app:unknown-tooling-json\\u001b[31m is unavailable because the app command cache is missing, stale, or does not contain that task.",
        },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("Given a command token with terminal controls, when plain diagnostics render, then raw controls do not reach stderr", async () => {
    // Given
    const commandToken = "does-not-exist\u001b[31m";

    // When
    const result = await runCli([commandToken]);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("\\u001b[31m");
    expect(result.stderr).not.toContain("\u001b");
  });

  test("Given a command token with terminal controls, when real JSON diagnostics render, then typed fields remain raw and messages are escaped", async () => {
    // Given
    const commandToken = "does-not-exist\u001b[31m";

    // When
    const result = await runCli([commandToken, "--format=json"]);
    const encoded: unknown = JSON.parse(result.stdout);
    const typedError = unknownCommandError(commandToken);

    // Then
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b");
    expect(encoded).toMatchObject({
      command: "cli:unknown-command",
      ok: false,
      error: {
        _tag: "UnknownCommandError",
        message: "Command does-not-exist\\u001b[31m not found",
      },
    });
    expect(typedError.commandToken).toBe(commandToken);
  });

  test("Given JSON output, when an unknown command is dispatched, then a valid machine failure envelope renders", async () => {
    // Given / When
    const result = await runCli(["does-not-exist", "--format=json"]);
    const envelope: unknown = JSON.parse(result.stdout);

    // Then
    expect(result.exitCode).toBe(1);
    expect(envelope).toMatchObject({
      command: "cli:unknown-command",
      ok: false,
      error: { _tag: "UnknownCommandError" },
    });
    expect(result.stderr).toBe("");
  });
});
