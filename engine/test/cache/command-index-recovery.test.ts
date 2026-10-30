import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect, Result } from "effect";
import {
  readAppCommandCacheForCwdDetailed,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";
import {
  type AppCommandIndexPayload,
  decodeAppCommandIndex,
  encodeAppCommandIndex,
} from "../../src/cache/command-index.ts";
import { appToolingCompilationCachePath } from "../../src/cache/paths.ts";
import { abi6Bytes } from "./fixtures/command-index-codec.ts";

interface Fixture {
  readonly cwd: string;
  readonly cacheRoot: string;
  readonly sourcePath: string;
  readonly cachePath: string;
}

const withApp = async (run: (fixture: Fixture) => Promise<void>) => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-cache-recovery-"));
  const cacheRoot = join(cwd, "cache");
  const sourcePath = join(cwd, ".lando.yml");
  try {
    await writeFile(sourcePath, "name: recovery\n");
    await run({ cwd, cacheRoot, sourcePath, cachePath: appToolingCompilationCachePath(cacheRoot, cwd) });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

const cache = (fixture: Fixture) =>
  Effect.runPromise(
    writeAppCommandCacheStrict({
      ...fixture,
      landofile: { name: "recovery" },
      entries: [
        {
          id: "app:known",
          summary: "Known",
          hidden: false,
          input: Result.getOrThrowWith(normalizeToolingInput("known", {}), (error) => error),
        },
      ],
    }),
  );

const updatePayload = async (
  fixture: Fixture,
  update: (payload: AppCommandIndexPayload) => AppCommandIndexPayload,
) => {
  const payload = decodeAppCommandIndex(await readFile(fixture.cachePath));
  if (payload === null) throw new TypeError("Fixture requires a decodable cache");
  await writeFile(fixture.cachePath, encodeAppCommandIndex(update(payload)));
};

test("reports missing metadata without attempting to parse the Landofile", async () => {
  await withApp(async (fixture) => {
    // Given
    await writeFile(fixture.sourcePath, "name: [invalid\n");
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toEqual({ status: "missing", sourcePath: fixture.sourcePath });
  });
});

test("returns fresh metadata including the real normalized input declaration", async () => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toMatchObject({
      status: "fresh",
      payload: { entries: [{ id: "app:known", input: { acceptsArguments: true, flags: [], args: [] } }] },
    });
  });
});

test.each(["corrupt", "old-format"] as const)("distinguishes %s metadata from missing", async (kind) => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    const bytes = kind === "corrupt" ? new Uint8Array([1, 2, 3]) : await readFile(fixture.cachePath);
    if (kind === "old-format")
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, 2n, true);
    await writeFile(fixture.cachePath, bytes);
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toEqual({ status: "invalid", sourcePath: fixture.sourcePath });
  });
});

test.each([
  { entries: undefined },
  { entries: [null] },
  { sourceReferencedFiles: [null] },
  { sourceScripts: [{ relativePath: null, sha256: "invalid" }] },
])("reports current-ABI shape corruption as invalid metadata %#", async (patch) => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    const payload = decodeAppCommandIndex(await readFile(fixture.cachePath));
    if (payload === null) throw new TypeError("Fixture requires a decodable cache");
    await writeFile(fixture.cachePath, abi6Bytes("LCAC", { ...payload, ...patch }));
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toEqual({ status: "invalid", sourcePath: fixture.sourcePath });
  });
});

test.each([
  { reason: "lando-version", update: (p: AppCommandIndexPayload) => ({ ...p, landoVersion: "old" }) },
  { reason: "source", update: (p: AppCommandIndexPayload) => ({ ...p, sourceContentHash: "changed" }) },
  { reason: "version-constraint", update: ({ versionConstraints: _, ...p }: AppCommandIndexPayload) => p },
] as const)("reports bounded $reason staleness without exposing payloads", async ({ reason, update }) => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    await updatePayload(fixture, update);
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toEqual({ status: "stale", staleReason: reason, sourcePath: fixture.sourcePath });
  });
});

test("detects source edits", async () => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    await writeFile(fixture.sourcePath, "name: changed\n");
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toMatchObject({ status: "stale", staleReason: "source" });
  });
});

test.each([false, true])("detects referenced-file changes (missing=%s)", async (missing) => {
  await withApp(async (fixture) => {
    // Given
    await cache(fixture);
    const path = join(fixture.cwd, "reference.txt");
    if (!missing) await writeFile(path, "changed");
    await updatePayload(fixture, (p) => ({
      ...p,
      sourceReferencedFiles: [{ absolutePath: path, size: 3, mtimeMs: 0, sha256: sha256Hex("old") }],
    }));
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toEqual({
      status: "stale",
      staleReason: "referenced-file",
      sourcePath: fixture.sourcePath,
    });
  });
});

test("detects script metadata changes without executing the script", async () => {
  await withApp(async (fixture) => {
    // Given
    await mkdir(join(fixture.cwd, ".lando/scripts"), { recursive: true });
    const script = join(fixture.cwd, ".lando/scripts/check.bun.sh");
    await writeFile(script, "# ---\n# desc: before\n# ---\nexit 99\n");
    await cache(fixture);
    await writeFile(script, "# ---\n# desc: after\n# ---\nexit 99\n");
    // When
    const receipt = await Effect.runPromise(readAppCommandCacheForCwdDetailed(fixture));
    // Then
    expect(receipt).toMatchObject({ status: "stale", staleReason: "script-metadata" });
  });
});

test.each([false, true])(
  "checks new script inventory only when requested (%s)",
  async (includeScriptInventory) => {
    await withApp(async (fixture) => {
      // Given
      await cache(fixture);
      await mkdir(join(fixture.cwd, ".lando/scripts"), { recursive: true });
      await writeFile(join(fixture.cwd, ".lando/scripts/new.bun.sh"), "# ---\n# desc: new\n# ---\nexit 99\n");
      // When
      const receipt = await Effect.runPromise(
        readAppCommandCacheForCwdDetailed({ ...fixture, includeScriptInventory }),
      );
      // Then
      expect(receipt).toMatchObject(
        includeScriptInventory ? { status: "stale", staleReason: "script-inventory" } : { status: "fresh" },
      );
    });
  },
);

test.each(["cache", "reference", "forms"] as const)(
  "preserves %s failures instead of reporting unavailable metadata",
  async (failure) => {
    await withApp(async (fixture) => {
      // Given
      await cache(fixture);
      switch (failure) {
        case "cache":
          await rm(fixture.cachePath);
          await mkdir(fixture.cachePath);
          break;
        case "reference":
          await updatePayload(fixture, (p) => ({
            ...p,
            sourceReferencedFiles: [
              { absolutePath: fixture.cwd, size: 0, mtimeMs: 0, sha256: sha256Hex("") },
            ],
          }));
          break;
        case "forms":
          await writeFile(join(fixture.cwd, ".lando.ts"), "throw 'must not execute';");
          break;
        default:
          failure satisfies never;
      }
      // When
      const result = await Effect.runPromise(Effect.result(readAppCommandCacheForCwdDetailed(fixture)));
      // Then
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: failure === "forms" ? "LandofileFormConflictError" : "CacheError" },
      });
    });
  },
);
