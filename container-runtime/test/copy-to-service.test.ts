import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { FakeEngine } from "./support/fake-engine.ts";

const passthroughRedactor = {
  redactString: (value: string) => value,
  redactValue: (value: unknown) => value,
} satisfies Redactor;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("keeps copy-in tar framing valid when the source grows before upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "lando-copy-race-"));
  roots.push(root);
  const sourcePath = join(root, "payload.sql");
  writeFileSync(sourcePath, "original");
  let uploaded: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const engine = new FakeEngine().seedContainer("lando-app-slug--web");
  engine.observers.set("archive.put", () => appendFileSync(sourcePath, "-concurrent-write"));
  const api = engine.api;
  const app = AppId.make("app-id");
  const provider = makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "none" },
    redactor: passthroughRedactor,
  });
  const plan = {
    id: app,
    name: "App Name",
    slug: "app-slug",
    root: AbsolutePath.make(root),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    metadata: {
      resolvedAt: "2026-09-14T00:00:00Z" as never,
      source: "copy race test",
      runtime: 4,
    },
    extensions: {},
  } satisfies AppPlan;

  await Effect.runPromise(
    provider.copyToService(
      { app, service: ServiceName.make("web"), plan },
      {
        sourcePath: AbsolutePath.make(sourcePath),
        targetPath: PortablePath.make("/tmp/payload.sql"),
      },
    ),
  );

  uploaded = engine.assets.uploads[0] ?? new Uint8Array();
  const declaredSize = Number.parseInt(new TextDecoder().decode(uploaded.subarray(124, 136)).trim(), 8);
  expect(declaredSize).toBe(8);
  expect(uploaded.byteLength).toBe(2048);
  expect(new TextDecoder().decode(uploaded.subarray(512, 512 + declaredSize))).toBe("original");
});

test("fails copy-in when the source shrinks before upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "lando-copy-race-"));
  roots.push(root);
  const sourcePath = join(root, "payload.sql");
  writeFileSync(sourcePath, "original");
  const engine = new FakeEngine().seedContainer("lando-app-slug--web");
  engine.observers.set("archive.put", () => truncateSync(sourcePath, 4));
  const api = engine.api;
  const app = AppId.make("app-id");
  const provider = makeProviderDataPlane({
    providerId: "test",
    api,
    capabilities: { volumeSnapshot: "none" },
    redactor: passthroughRedactor,
  });
  const plan = {
    id: app,
    name: "App Name",
    slug: "app-slug",
    root: AbsolutePath.make(root),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    metadata: {
      resolvedAt: "2026-09-14T00:00:00Z" as never,
      source: "copy race test",
      runtime: 4,
    },
    extensions: {},
  } satisfies AppPlan;

  const exit = await Effect.runPromiseExit(
    provider.copyToService(
      { app, service: ServiceName.make("web"), plan },
      {
        sourcePath: AbsolutePath.make(sourcePath),
        targetPath: PortablePath.make("/tmp/payload.sql"),
      },
    ),
  );

  expect(exit._tag).toBe("Failure");
});
