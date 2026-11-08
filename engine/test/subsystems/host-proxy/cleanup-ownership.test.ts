import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { createHostProxyRunLandoSession } from "../../../src/subsystems/host-proxy/transport.ts";
import { terminateOwnedHostProxyWorker } from "../../../src/subsystems/host-proxy/worker-ownership.ts";
import {
  withWorkerRecordLock,
  workerStatePath,
} from "../../../src/subsystems/host-proxy/worker-state-file.ts";

test("transport shutdown leaves the parent claim intact without waiting for its held lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-child-cleanup-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  const paths = { userDataRoot: root };
  const shim = join(root, "helper");
  await Bun.write(shim, "helper");
  const session = await Effect.runPromise(
    createHostProxyRunLandoSession({
      app,
      paths,
      shimArtifactPath: shim,
      mountInfo: { hostRoot: root, containerRoot: "/app" },
      callerService: "web",
      allowlist: [],
      executor: () => Effect.die("unused"),
    }).pipe(Effect.provideService(RedactionService, makeRedactionService())),
  );
  const recordPath = workerStatePath(app, paths);
  const privateFileAccess = { enforce: async () => undefined, verify: async () => undefined };
  try {
    await Bun.write(recordPath, "parent-owned-claim");
    await Effect.runPromise(
      withWorkerRecordLock(app, paths, () => Effect.promise(() => session.close()), privateFileAccess),
    );
    expect(await Bun.file(recordPath).text()).toBe("parent-owned-claim");
    expect(await readdir(join(recordPath, ".."))).toEqual(["worker.json"]);
    await Effect.runPromise(terminateOwnedHostProxyWorker(app, { paths, privateFileAccess }));
    expect(await Bun.file(recordPath).exists()).toBe(false);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
