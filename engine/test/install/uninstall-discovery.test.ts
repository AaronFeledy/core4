import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AbsolutePath, AppId, AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime, Schema } from "effect";
import { makeListDiscoveredApps } from "../../src/install/uninstall-discovery.ts";
import type { RuntimeExec } from "../../src/install/uninstall-runtime.ts";

const absentRuntime: RuntimeExec = async () => {
  throw Object.assign(new Error("not installed"), { code: "ENOENT" });
};
const recordPath = "plugins/@lando/provider-podman/applied-plans.json";
const perAppLayouts = [
  { path: "plugins/@lando/provider-lando/applied-plans/app.json", field: "data" },
  { path: "plugins/@lando/provider-docker/applied-plans/app.json", field: "data" },
  { path: "providers/provider-lando/apps/app.json", field: "plan" },
] as const;

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-discovery-"));
  const data = join(root, "data");
  const cache = join(root, "cache");
  return {
    data,
    plan: (id: string) =>
      Schema.encodeSync(AppPlan)({
        id: AppId.make(id),
        name: id,
        slug: id,
        root: AbsolutePath.make(join(root, id)),
        provider: ProviderId.make("podman"),
        services: {},
        routes: [],
        stores: [],
        fileSync: [],
        metadata: {
          resolvedAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
          source: ".lando.yml",
          runtime: 4,
        },
        extensions: {},
      }),
    write: (path: string, contents: string) => {
      const target = join(data, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    },
    discover: (exec: RuntimeExec = absentRuntime) => makeListDiscoveredApps(exec, "linux")(data, cache),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("returns no apps when runtimes and recorded plans are absent", async () => {
  // Given
  using f = fixture();
  // When / Then
  await expect(f.discover()).resolves.toEqual([]);
});

for (const ids of [[], ["global"], ["user-app"], ["global", "user-app"]]) {
  test(`checks record-layout apps without a runtime: ${JSON.stringify(ids)}`, async () => {
    // Given
    using f = fixture();
    f.write(
      recordPath,
      JSON.stringify({ version: 1, data: Object.fromEntries(ids.map((id) => [id, f.plan(id)])) }),
    );
    // When
    const result = f.discover();
    // Then
    if (ids.includes("user-app")) {
      await expect(result).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
    } else {
      await expect(result).resolves.toEqual([]);
    }
  });
}

for (const layout of perAppLayouts) {
  for (const id of ["global", "user-app"]) {
    test(`preserves ${layout.path} discovery for ${id} without a runtime`, async () => {
      // Given
      using f = fixture();
      f.write(layout.path, JSON.stringify({ version: 1, [layout.field]: f.plan(id) }));
      // When
      const result = f.discover();
      // Then
      if (id === "global") {
        await expect(result).resolves.toEqual([]);
      } else {
        await expect(result).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
      }
    });
  }
}

test("does not overlook a record-layout user app beside global-only per-app state", async () => {
  // Given
  using f = fixture();
  f.write(
    "plugins/@lando/provider-podman/applied-plans/global.json",
    JSON.stringify({ version: 1, data: f.plan("global") }),
  );
  f.write(recordPath, JSON.stringify({ version: 1, data: { app: f.plan("app") } }));
  // When / Then
  await expect(f.discover()).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
});

for (const contents of [
  "{",
  "null",
  "{}",
  '{"version":1}',
  '{"version":2,"data":{}}',
  '{"version":1,"data":null}',
  '{"version":1,"data":[]}',
  '{"version":1,"data":{"global":null}}',
  '{"version":1,"data":{"global":{"id":"global"}}}',
]) {
  test(`fails closed with a tagged error for malformed record ${contents}`, async () => {
    // Given
    using f = fixture();
    f.write(recordPath, contents);
    // When / Then
    await expect(f.discover()).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
  });
}

for (const layout of perAppLayouts) {
  test(`tags malformed per-app JSON at ${layout.path}`, async () => {
    // Given
    using f = fixture();
    f.write(layout.path, "{");
    // When / Then
    await expect(f.discover()).rejects.toMatchObject({ _tag: "UninstallResourceCleanupError" });
  });
}

for (const path of [recordPath, ...perAppLayouts.map((layout) => layout.path)]) {
  test(`tags unreadable applied state at ${path}`, async () => {
    // Given a directory where a file is required (deterministic even as root).
    using f = fixture();
    mkdirSync(join(f.data, path), { recursive: true });
    // When / Then
    await expect(f.discover()).rejects.toMatchObject({
      _tag: "UninstallResourceCleanupError",
      cause: expect.objectContaining({ code: "EISDIR" }),
    });
  });
}

for (const label of ["dev.lando.app", "com.lando.app"]) {
  test(`rejects partial discovery when a later runtime fails ps for ${label}`, async () => {
    // Given Docker has apps, but Podman cannot finish discovery.
    using f = fixture();
    const failure = new Error("ps failed");
    const queried: string[] = [];
    const exec: RuntimeExec = async (file, args) => {
      if (file !== "docker" && file !== "podman") return absentRuntime(file, args, { timeout: 0 });
      if (args.includes("--version")) return { stdout: file };
      queried.push(file);
      if (file === "podman" && args.includes(`label=${label}`)) throw failure;
      return { stdout: "known-app\n" };
    };
    // When
    const result = f.discover(exec);
    // Then
    await expect(result).rejects.toMatchObject({
      _tag: "UninstallResourceCleanupError",
      message: expect.stringContaining("podman"),
      cause: failure,
    });
    expect(queried).toContain("docker");
  });
}

test("deduplicates labels per runtime while preserving provider context", async () => {
  // Given both runtimes report the same app under both label generations.
  using f = fixture();
  const exec: RuntimeExec = async (file, args) => {
    if (file !== "docker" && file !== "podman") return absentRuntime(file, args, { timeout: 0 });
    return { stdout: args.includes("--version") ? file : "shared-app\nshared-app\n" };
  };
  // When
  const apps = await f.discover(exec);
  // Then
  expect(apps).toEqual(
    ["docker", "podman"].map((providerId) => ({
      appId: "shared-app",
      appName: "shared-app",
      providerId,
      appRoot: "(unknown)",
      services: [],
    })),
  );
});
