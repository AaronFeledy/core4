import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import { commandAliasRegistrationError } from "../../src/cli/command-alias-policy.ts";
import { resolveAppCommandHelpAliases, resolveToolingRoute } from "../../src/cli/tooling-router.ts";

const withAliasCache = async <T>(
  commandAliases: {
    readonly enabled?: boolean;
    readonly disabled?: ReadonlyArray<string>;
    readonly custom?: Readonly<Record<string, string>>;
  },
  run: (fixture: { readonly root: string; readonly cacheRoot: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-app-command-aliases-"));
  const cacheRoot = join(root, "cache");
  try {
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(join(root, ".lando.yml"), "name: alias-app\n");
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        landofile: { name: "alias-app", commandAliases },
        entries: [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }],
        cwd: root,
        cacheRoot,
      }),
    );
    return await run({ root, cacheRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("custom aliases override registered built-in aliases and target cached tooling", async () => {
  await withAliasCache({ custom: { start: "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given
    const argv = ["start", "friend"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "bun-script",
      commandId: "app:greet",
      name: "greet",
    });
    expect(argv.slice(1)).toEqual(["friend"]);
  });
});

test("colon-form custom aliases resolve through the app policy", async () => {
  await withAliasCache({ custom: { "project:greet": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given
    const argv = ["project:greet", "friend"] as const;

    // When
    const route = await Effect.runPromise(resolveToolingRoute(argv[0], { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "bun-script",
      commandId: "app:greet",
      name: "greet",
    });
    expect(argv.slice(1)).toEqual(["friend"]);
  });
});

test("disabled built-in aliases do not block canonical command ids", async () => {
  await withAliasCache({ disabled: ["start"] }, async ({ root, cacheRoot }) => {
    // Given / When
    const disabled = await Effect.runPromise(resolveToolingRoute("start", { cwd: root, cacheRoot }));
    const canonical = await Effect.runPromise(resolveToolingRoute("app:start", { cwd: root, cacheRoot }));

    // Then
    expect(disabled).toMatchObject({ _tag: "alias-disabled", token: "start" });
    expect(canonical).toMatchObject({ _tag: "not-tooling" });
  });
});

test("enabled false only suppresses aliases", async () => {
  await withAliasCache({ enabled: false, custom: { hi: "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const [alias, tooling, unknown] = await Promise.all([
      Effect.runPromise(resolveToolingRoute("hi", { cwd: root, cacheRoot })),
      Effect.runPromise(resolveToolingRoute("greet", { cwd: root, cacheRoot })),
      Effect.runPromise(resolveToolingRoute("missing", { cwd: root, cacheRoot })),
    ]);

    // Then
    expect(alias).toMatchObject({ _tag: "alias-disabled", token: "hi" });
    expect(tooling).toMatchObject({ _tag: "bun-script", commandId: "app:greet", name: "greet" });
    expect(unknown).toMatchObject({ _tag: "unknown-tooling", commandId: "app:missing" });
  });
});

const dormantInvalidPolicies = [
  ["unknown targets", { hi: "app:missing" }, "hi"],
  ["canonical collisions", { "app:greet": "app:greet" }, "start"],
] as const;

test.each(dormantInvalidPolicies)(
  "enabled false ignores dormant %s during routing",
  async (_case, custom, token) => {
    await withAliasCache({ enabled: false, custom }, async ({ root, cacheRoot }) => {
      // Given / When
      const route = await Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot }));

      // Then
      expect(route).toEqual({ _tag: "alias-disabled", token });
    });
  },
);

test.each(dormantInvalidPolicies)("enabled false ignores dormant %s in root help", async (_case, custom) => {
  await withAliasCache({ enabled: false, custom }, async ({ root, cacheRoot }) => {
    // Given / When
    const aliases = await Effect.runPromise(resolveAppCommandHelpAliases({ cwd: root, cacheRoot }));

    // Then
    expect(aliases).toEqual([]);
  });
});

test.each(dormantInvalidPolicies)(
  "enabled false with dormant %s keeps canonical cached commands available",
  async (_case, custom) => {
    await withAliasCache({ enabled: false, custom }, async ({ root, cacheRoot }) => {
      // Given / When
      const route = await Effect.runPromise(resolveToolingRoute("app:greet", { cwd: root, cacheRoot }));

      // Then
      expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:greet", name: "greet" });
    });
  },
);

test("custom keys cannot claim a canonical command id", async () => {
  await withAliasCache({ custom: { "app:start": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

    // Then
    expect(error).toBeInstanceOf(CommandAliasConflictError);
    expect(error).toMatchObject({
      alias: "app:start",
      reservedFor: "app:start",
      remediation: expect.stringContaining("canonical id"),
    });
  });
});

test.each(["help", "--help", "--version", "-V", "--custom"] as const)(
  "reserved token %s cannot be claimed by a custom alias",
  async (alias) => {
    await withAliasCache({ custom: { [alias]: "app:greet" } }, async ({ root, cacheRoot }) => {
      // Given / When
      const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

      // Then
      expect(error).toBeInstanceOf(CommandAliasConflictError);
      expect(error).toMatchObject({ alias, reservedFor: alias });
    });
  },
);

test("unregistered aliases cannot claim a reserved namespace", async () => {
  await withAliasCache({ custom: { "app:shortcut": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

    // Then
    expect(error).toBeInstanceOf(CommandAliasConflictError);
    expect(error).toMatchObject({ alias: "app:shortcut", reservedFor: "app" });
  });
});

test("registered colon aliases remain available for explicit app remapping", async () => {
  await withAliasCache({ custom: { "scratch:gc": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const route = await Effect.runPromise(resolveToolingRoute("scratch:gc", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:greet" });
  });
});

test("unknown custom targets fail with close matches and remediation", async () => {
  await withAliasCache({ custom: { hi: "app:grete" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

    // Then
    expect(error).toBeInstanceOf(CommandAliasTargetError);
    expect(error).toMatchObject({
      alias: "hi",
      target: "app:grete",
      closeMatches: expect.arrayContaining(["app:greet"]),
      remediation: expect.stringContaining("app:cache:refresh"),
    });
  });
});

test("oversized unknown targets still receive fuzzy suggestions", async () => {
  const target = `app:greet${"x".repeat(1_024)}`;
  await withAliasCache({ custom: { hi: target } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

    // Then
    expect(error).toBeInstanceOf(CommandAliasTargetError);
    if (!(error instanceof CommandAliasTargetError)) throw error;
    expect(error.target).toBe(target);
    expect(error.closeMatches).toContain("app:greet");
  });
});

test("alias diagnostics escape terminal control characters", async () => {
  const alias = "bad\u001b[2J";
  await withAliasCache({ custom: { [alias]: "app:missing" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(Effect.flip(resolveToolingRoute("hi", { cwd: root, cacheRoot })));

    // Then
    if (!(error instanceof CommandAliasTargetError)) throw error;
    expect(error.message).toContain("bad\\u001b[2J");
    expect(error.message).not.toContain("\u001b");
  });
});

test("CommandAliasTargetError remediation escapes close-match terminal controls", () => {
  // Given: a canonical app command id with terminal controls, and an unknown target that
  // selects it as a close match
  const poisonedId = "app:greet\u001b[2J";
  const target = "app:greet\u001b[2K";

  // When
  const error = commandAliasRegistrationError({ custom: { hi: target } }, [poisonedId]);

  // Then
  expect(error).toBeInstanceOf(CommandAliasTargetError);
  if (!(error instanceof CommandAliasTargetError)) throw error;
  expect(error.closeMatches).toContain(poisonedId);
  expect(error.remediation).toContain("app:greet\\u001b[2J");
  expect(error.remediation).not.toContain("\u001b");
});

test.each(["--help", "-h", "--version", "-V", "-v"] as const)(
  "flag token %s is not-tooling when aliases are disabled",
  async (token) => {
    await withAliasCache({ enabled: false }, async ({ root, cacheRoot }) => {
      // Given / When
      const route = await Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot }));

      // Then
      expect(route).toMatchObject({ _tag: "not-tooling" });
    });
  },
);

test.each(["--help", "-h", "--version", "-V", "-v"] as const)(
  "flag token %s is not-tooling when listed in disabled",
  async (token) => {
    await withAliasCache({ disabled: [token] }, async ({ root, cacheRoot }) => {
      // Given / When
      const route = await Effect.runPromise(resolveToolingRoute(token, { cwd: root, cacheRoot }));

      // Then
      expect(route).toMatchObject({ _tag: "not-tooling" });
    });
  },
);

test("prototype-inherited custom keys are ignored", async () => {
  await withAliasCache({ custom: {} }, async ({ root, cacheRoot }) => {
    // Given / When — Object.prototype has toString; empty custom must not inherit it
    const route = await Effect.runPromise(resolveToolingRoute("toString", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "unknown-tooling",
      commandId: "app:toString",
      name: "toString",
    });
  });
});

test("explicit own custom key constructor resolves", async () => {
  await withAliasCache({ custom: { constructor: "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const route = await Effect.runPromise(resolveToolingRoute("constructor", { cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({
      _tag: "bun-script",
      commandId: "app:greet",
      name: "greet",
    });
  });
});
