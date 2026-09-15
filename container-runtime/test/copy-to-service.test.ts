import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const collect = async (input: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

test("keeps copy-in tar framing valid when the source grows before upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "lando-copy-race-"));
  roots.push(root);
  const sourcePath = join(root, "payload.sql");
  writeFileSync(sourcePath, "original");
  let uploaded: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.promise(async () => {
        if (request.stdin !== undefined) {
          appendFileSync(sourcePath, "-concurrent-write");
          uploaded = await collect(request.stdin);
        }
        return { status: 200, body: "{}" };
      }),
  };
  const app = AppId.make("app-id");
  const provider = makeProviderDataPlane({
    providerId: "test",
    api,
    snapshotMode: "copy",
    redactDetails: (value) => value,
  });
  const plan = {
    id: app,
    name: "App Name",
    slug: "app-slug",
    root: AbsolutePath.make(root),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    networks: [],
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
  const api: DataPlaneApiClient = {
    request: (request) =>
      Effect.promise(async () => {
        if (request.stdin !== undefined) {
          truncateSync(sourcePath, 4);
          await collect(request.stdin);
        }
        return { status: 200, body: "{}" };
      }),
  };
  const app = AppId.make("app-id");
  const provider = makeProviderDataPlane({
    providerId: "test",
    api,
    snapshotMode: "copy",
    redactDetails: (value) => value,
  });
  const plan = {
    id: app,
    name: "App Name",
    slug: "app-slug",
    root: AbsolutePath.make(root),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    networks: [],
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
