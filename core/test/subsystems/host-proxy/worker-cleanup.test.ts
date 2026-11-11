import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDetachedHostProxyWorker } from "@lando/engine/subsystems/host-proxy/detached-worker";
import {
  type HostProxyWorkerProcess,
  defaultSpawnWorker,
} from "@lando/engine/subsystems/host-proxy/worker-process";
import {
  probeWorker,
  readWorkerRecord,
  workerStatePath,
} from "@lando/engine/subsystems/host-proxy/worker-state";
import { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import "../../../src/runtime/engine-composition.ts";
import { ownerOnlyFileAccess } from "../../_support/private-file-access.ts";

test("a child exiting independently leaves a dead claim which the next start replaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-worker-stale-claim-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: app.id,
    name: app.id,
    slug: app.id,
    root,
    provider: "lando",
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
  });
  const shimArtifactPath = join(root, "helper");
  await Bun.write(shimArtifactPath, "#!/bin/sh\nexit 0\n");
  let child: HostProxyWorkerProcess | undefined;
  const options = {
    app,
    plan,
    paths: { userDataRoot: root },
    shimArtifactPath,
    privateFileAccess: ownerOnlyFileAccess,
    spawnWorker: async (spec: Parameters<typeof defaultSpawnWorker>[0]) => {
      child = await defaultSpawnWorker({ ...spec, logsDir: root });
      return child;
    },
  };
  const first = await Effect.runPromise(startDetachedHostProxyWorker(options));
  try {
    const before = await Effect.runPromise(readWorkerRecord(app, options.paths));
    if (child === undefined || before === undefined) throw new TypeError("Worker was not published");
    await child.terminate();
    const path = workerStatePath(app, options.paths);
    expect(await readdir(dirname(path))).toEqual(["worker.json"]);
    expect(await Effect.runPromise(readWorkerRecord(app, options.paths))).toEqual(before);
    expect(await Effect.runPromise(probeWorker(before))).toBe("dead");
    const second = await Effect.runPromise(startDetachedHostProxyWorker(options));
    try {
      expect(second.reused).toBe(false);
      expect(second.sessionId).not.toBe(first.sessionId);
      const after = await Effect.runPromise(readWorkerRecord(app, options.paths));
      if (after === undefined) throw new TypeError("Replacement was not published");
      expect(await Effect.runPromise(probeWorker(after))).toBe("live");
    } finally {
      await second.close();
    }
    expect(await Bun.file(path).exists()).toBe(false);
  } finally {
    await first.close();
    if (child !== undefined) await child.terminate();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
