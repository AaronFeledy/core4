import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
import { resolveToolingRoute } from "../../src/cli/tooling-router.ts";

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
    // Given / When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["start", "friend"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toMatchObject({
      _tag: "bun-script",
      commandId: "app:greet",
      name: "greet",
      argv: ["friend"],
    });
  });
});

test("colon-form custom aliases resolve through the app policy", async () => {
  await withAliasCache({ custom: { "project:greet": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["project:greet", "friend"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toMatchObject({
      _tag: "bun-script",
      commandId: "app:greet",
      name: "greet",
      argv: ["friend"],
    });
  });
});

test("disabled built-in aliases do not block canonical command ids", async () => {
  await withAliasCache({ disabled: ["start"] }, async ({ root, cacheRoot }) => {
    // Given / When
    const disabled = await Effect.runPromise(resolveToolingRoute({ argv: ["start"], cwd: root, cacheRoot }));
    const canonical = await Effect.runPromise(
      resolveToolingRoute({ argv: ["app:start"], cwd: root, cacheRoot }),
    );

    // Then
    expect(disabled).toMatchObject({ _tag: "alias-disabled", token: "start" });
    expect(canonical).toMatchObject({ _tag: "not-tooling" });
  });
});

test("enabled false suppresses custom aliases", async () => {
  await withAliasCache({ enabled: false, custom: { hi: "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const route = await Effect.runPromise(resolveToolingRoute({ argv: ["hi"], cwd: root, cacheRoot }));

    // Then
    expect(route).toMatchObject({ _tag: "alias-disabled", token: "hi" });
  });
});

test("custom keys cannot claim a canonical command id", async () => {
  await withAliasCache({ custom: { "app:start": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(
      Effect.flip(resolveToolingRoute({ argv: ["hi"], cwd: root, cacheRoot })),
    );

    // Then
    expect(error).toBeInstanceOf(CommandAliasConflictError);
    expect(error).toMatchObject({
      alias: "app:start",
      reservedFor: "app:start",
      remediation: expect.stringContaining("canonical id"),
    });
  });
});

test.each(["help", "--help", "--version", "-V"] as const)(
  "reserved token %s cannot be claimed by a custom alias",
  async (alias) => {
    await withAliasCache({ custom: { [alias]: "app:greet" } }, async ({ root, cacheRoot }) => {
      // Given / When
      const error = await Effect.runPromise(
        Effect.flip(resolveToolingRoute({ argv: ["hi"], cwd: root, cacheRoot })),
      );

      // Then
      expect(error).toBeInstanceOf(CommandAliasConflictError);
      expect(error).toMatchObject({ alias, reservedFor: alias });
    });
  },
);

test("unregistered aliases cannot claim a reserved namespace", async () => {
  await withAliasCache({ custom: { "app:shortcut": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(
      Effect.flip(resolveToolingRoute({ argv: ["hi"], cwd: root, cacheRoot })),
    );

    // Then
    expect(error).toBeInstanceOf(CommandAliasConflictError);
    expect(error).toMatchObject({ alias: "app:shortcut", reservedFor: "app" });
  });
});

test("registered colon aliases remain available for explicit app remapping", async () => {
  await withAliasCache({ custom: { "scratch:gc": "app:greet" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const route = await Effect.runPromise(
      resolveToolingRoute({ argv: ["scratch:gc"], cwd: root, cacheRoot }),
    );

    // Then
    expect(route).toMatchObject({ _tag: "bun-script", commandId: "app:greet" });
  });
});

test("unknown custom targets fail with close matches and remediation", async () => {
  await withAliasCache({ custom: { hi: "app:grete" } }, async ({ root, cacheRoot }) => {
    // Given / When
    const error = await Effect.runPromise(
      Effect.flip(resolveToolingRoute({ argv: ["hi"], cwd: root, cacheRoot })),
    );

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
