import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { FileNotFoundError } from "@lando/sdk/errors";

import { watcherDiagnosticFile } from "../src/proxy-paths.ts";
import type { ProxyFileSystem, ProxyPaths } from "../src/proxy-types.ts";
import {
  clearWatcherDiagnostic,
  readWatcherDiagnostic,
  writeWatcherDiagnostic,
} from "../src/watcher-diagnostic-state.ts";

const paths: ProxyPaths = { platform: "linux", globalAppRoot: "/lando/global" };

const fullRecord = {
  version: 1 as const,
  observedAt: "2026-09-18T12:00:00.000Z",
  providerId: "lando",
  watcherHost: "host.lando.internal",
  failureClass: "inotify-limit" as const,
  detail: "fs.inotify.max_user_watches exhausted",
};

const makeMemoryFs = (): { files: Map<string, string>; fileSystem: ProxyFileSystem } => {
  const files = new Map<string, string>();
  const fileSystem: ProxyFileSystem = {
    mkdir: () => Effect.void,
    writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
    writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
    remove: (path) => Effect.sync(() => void files.delete(path)),
    exists: (path) => Effect.succeed(files.has(path)),
    readDir: (path) =>
      Effect.succeed(
        [...files.keys()]
          .filter((file) => file.startsWith(`${path}/`))
          .map((file) => file.slice(path.length + 1)),
      ),
    // Real FileSystem fails on missing paths; that is what readWatcherDiagnostic must catch.
    readText: (path) => {
      if (files.has(path)) {
        return Effect.succeed(files.get(path) ?? "");
      }
      return Effect.fail(new FileNotFoundError({ message: "removed", path }));
    },
  };
  return { files, fileSystem };
};

describe("watcher diagnostic state", () => {
  test("watcherDiagnosticFile resolves under globalAppRoot/proxy-traefik", () => {
    expect(watcherDiagnosticFile(paths)).toBe("/lando/global/proxy-traefik/watcher-diagnostic.json");
  });

  test("watcherDiagnosticFile path does not live under the watched dynamic directory", () => {
    const path = watcherDiagnosticFile(paths);
    // The record must live outside the watched directory so Traefik does not
    // reload (or the watcher re-fire) when the diagnostic file is written.
    expect(path.includes("/dynamic")).toBe(false);
  });

  test("write then read round-trips every field of a full record", async () => {
    const { fileSystem } = makeMemoryFs();

    await Effect.runPromise(writeWatcherDiagnostic(fileSystem, paths, fullRecord));
    const read = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));

    expect(read).toEqual(fullRecord);
  });

  test("read of undecodable content returns undefined", async () => {
    const { files, fileSystem } = makeMemoryFs();
    files.set(watcherDiagnosticFile(paths), "{ not json");

    const read = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));

    expect(read).toBeUndefined();
  });

  test("read of valid JSON with the wrong shape returns undefined", async () => {
    const { files, fileSystem } = makeMemoryFs();
    files.set(watcherDiagnosticFile(paths), JSON.stringify({ version: 2 }));

    const read = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));

    expect(read).toBeUndefined();
  });

  test("read of a missing file returns undefined", async () => {
    const { fileSystem } = makeMemoryFs();

    const read = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));

    expect(read).toBeUndefined();
  });

  test("clear removes a written record and is a no-op when already absent", async () => {
    const { fileSystem } = makeMemoryFs();

    await Effect.runPromise(writeWatcherDiagnostic(fileSystem, paths, fullRecord));
    await Effect.runPromise(clearWatcherDiagnostic(fileSystem, paths));
    const afterClear = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));
    expect(afterClear).toBeUndefined();

    await Effect.runPromise(clearWatcherDiagnostic(fileSystem, paths));
    const afterAbsentClear = await Effect.runPromise(readWatcherDiagnostic(fileSystem, paths));
    expect(afterAbsentClear).toBeUndefined();
  });

  test("serialized JSON on disk has no remediation key", async () => {
    const { files, fileSystem } = makeMemoryFs();

    await Effect.runPromise(writeWatcherDiagnostic(fileSystem, paths, fullRecord));
    const stored = files.get(watcherDiagnosticFile(paths));
    expect(stored).toBeDefined();
    const parsed: unknown = JSON.parse(stored ?? "");
    // Remediation is derived at read time, never persisted.
    expect(Object.hasOwn(parsed as object, "remediation")).toBe(false);
  });
});
