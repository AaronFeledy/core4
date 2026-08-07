import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { EventService, SecretStore } from "@lando/sdk/services";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const engineSourceRoot = resolve(repositoryRoot, "engine/src");
const coreSourceRoot = resolve(repositoryRoot, "core/src");

const runtimeBrainDirectories = [
  "app",
  "cache",
  "config",
  "data-mover",
  "deprecation",
  "downloader",
  "errors",
  "global-app",
  "http-client",
  "landofile",
  "lifecycle",
  "logging",
  "managed-file",
  "operations",
  "platform",
  "plugins",
  "providers",
  "redaction",
  "runtime",
  "schema",
  "scratch-app",
  "services",
  "state",
  "state-store",
  "subsystems",
  "telemetry",
  "tooling",
  "tunnel",
  "utils",
] as const;

const coreShellDirectories = new Set(["cli", "docs", "interaction", "mcp", "recipes", "testing"]);
const coreRootFiles = new Set(["index.ts", "version.ts"]);
const coreRuntimeAllowlist = new Set([
  "app/index.ts",
  "app/resolve.ts",
  "app/runtime.ts",
  "config/paths.ts",
  "errors/index.ts",
  "landofile/index.ts",
  "lifecycle/index.ts",
  "plugins/generated",
  "runtime/generated",
  "runtime/engine-composition.ts",
  "runtime/layer.ts",
  "schema/index.ts",
  "secrets/index.ts",
  "services/index.ts",
]);
const pluginPackagePattern =
  /^@lando\/(?:ca-|file-sync-|logger-|notify-|provider-|proxy-|renderer-|service-|template-)/u;
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)["']([^"']+)["']|\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu;
const hostShellOwnershipPatterns = [
  /["']node:readline(?:\/promises)?["']/u,
  /["']node:tty["']/u,
  /\bprocess\.(?:stdin|stdout|stderr)\b/u,
  /import\s*\{[^}]*\b(?:stdin|stdout|stderr)\b[^}]*\}\s*from\s*["']node:process["']/u,
  /\.setRawMode\s*\(/u,
] as const;
const processEntryOwnershipPatterns = [/\bprocess\.argv\b/u, /\bimport\.meta\.(?:url|dirname)\b/u] as const;

const sourceFiles = async (root: string): Promise<readonly string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(root, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return files.flat();
};

const corePathAllowed = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/");
  const [directory] = normalized.split("/");
  if (directory !== undefined && coreShellDirectories.has(directory)) return true;
  if (coreRootFiles.has(normalized)) return true;
  return [...coreRuntimeAllowlist].some(
    (allowed) => normalized === allowed || normalized.startsWith(`${allowed}/`),
  );
};

describe("Engine closure", () => {
  test("engine source imports no shell or out-of-package modules", async () => {
    // Given
    const files = await sourceFiles(engineSourceRoot);

    // When
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await Bun.file(file).text();
          return [...source.matchAll(importPattern)].flatMap((match) => {
            const specifier = match[1] ?? match[2];
            if (specifier === undefined) return [];
            const staysWithinEngineSource =
              specifier.startsWith(".") &&
              !relative(engineSourceRoot, resolve(dirname(file), specifier)).startsWith("..");
            const forbidden =
              specifier === "@lando/core" ||
              specifier.startsWith("@lando/core/") ||
              pluginPackagePattern.test(specifier) ||
              (specifier.startsWith(".") && !staysWithinEngineSource);
            return forbidden ? [`${relative(engineSourceRoot, file)} -> ${specifier}`] : [];
          });
        }),
      )
    ).flat();

    // Then
    expect(violations).toEqual([]);
  });

  test("engine source owns no process terminal readline or install-entry facts", async () => {
    // Given
    const files = await sourceFiles(engineSourceRoot);

    // When
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await Bun.file(file).text();
          const relativePath = relative(engineSourceRoot, file).replaceAll("\\", "/");
          const patterns = [
            ...hostShellOwnershipPatterns,
            ...processEntryOwnershipPatterns,
            ...(relativePath === "platform/tty.ts" ? [] : [/\.isTTY\b/u]),
          ];
          return patterns.flatMap((pattern) =>
            pattern.test(source) ? [`${relativePath} -> ${pattern.source}`] : [],
          );
        }),
      )
    ).flat();

    // Then
    expect(violations).toEqual([]);
  });

  test("engine runtime services operate using engine-only layers", async () => {
    // Given
    const [{ EventServiceLive }, { RedactionServiceLive }] = await Promise.all([
      import("@lando/engine/services/event-service"),
      import("@lando/engine/redaction/service"),
    ]);
    const secretStore = Layer.succeed(SecretStore, {
      id: "engine-closure",
      get: () => Effect.die("unused"),
      has: () => Effect.succeed(false),
      list: Effect.succeed([]),
    });
    const redaction = RedactionServiceLive.pipe(Layer.provide(secretStore));
    const layer = EventServiceLive.pipe(Layer.provide(redaction));

    // When
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* EventService;
        yield* service.publish({ _tag: "engine-closure-smoke", value: "ok" });
        return yield* service.query("engine-closure-smoke");
      }).pipe(Effect.provide(layer), Effect.scoped),
    );

    // Then
    expect(events).toEqual([{ _tag: "engine-closure-smoke", value: "ok" }]);
  });

  test("runtime brain lives in engine and core contains only shell composition generated and shims", async () => {
    // Given
    const [engineEntries, coreFiles] = await Promise.all([
      readdir(engineSourceRoot, { withFileTypes: true }),
      sourceFiles(coreSourceRoot),
    ]);

    // When
    const engineDirectories = new Set(
      engineEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    );
    const missingDirectories = runtimeBrainDirectories.filter(
      (directory) => !engineDirectories.has(directory),
    );
    const normalizedCoreFiles = coreFiles.map((file) => relative(coreSourceRoot, file).replaceAll("\\", "/"));
    const unexpectedCoreFiles = normalizedCoreFiles.filter((file) => !corePathAllowed(file));
    const unusedCoreAllowlistEntries = [...coreRuntimeAllowlist].filter(
      (allowed) => !normalizedCoreFiles.some((file) => file === allowed || file.startsWith(`${allowed}/`)),
    );

    // Then
    expect({ missingDirectories, unexpectedCoreFiles, unusedCoreAllowlistEntries }).toEqual({
      missingDirectories: [],
      unexpectedCoreFiles: [],
      unusedCoreAllowlistEntries: [],
    });
  });
});
