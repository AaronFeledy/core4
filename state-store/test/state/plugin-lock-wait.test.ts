import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";

import { makePluginStateStore } from "../../src/plugin.ts";
import { makeTestStateStore } from "../../src/testing.ts";
import { lockTestAccess } from "./lock-test-access.ts";

test("plugin lock can wait past the default deadline for a live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-lock-wait-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { AbsolutePath } from ${JSON.stringify(import.meta.resolve("@lando/sdk/schema"))};
        import { makePluginStateStore } from ${JSON.stringify(import.meta.resolve("../../src/plugin.ts"))};
        import { makeTestStateStore } from ${JSON.stringify(import.meta.resolve("../../src/testing.ts"))};
        import { lockTestAccess } from ${JSON.stringify(import.meta.resolve("./lock-test-access.ts"))};
        const store = makePluginStateStore(
          makeTestStateStore().service,
          AbsolutePath.make(${JSON.stringify(root)}),
          lockTestAccess,
        );
        await Effect.runPromise(store.withLock("routes.lock", Effect.promise(async () => {
          process.stdout.write("held\\n");
          await Bun.sleep(2500);
        })));
      `,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  try {
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    const store = makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), lockTestAccess);
    const acquired = await Effect.runPromise(
      store.withLock("routes.lock", Effect.succeed("second owner"), { timeoutMs: 5_000 }),
    );
    expect(acquired).toBe("second owner");
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  } finally {
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin lock rejects an unbounded runtime wait before opening a lock", async () => {
  const store = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make(join(tmpdir(), "lando-invalid-plugin-lock-wait")),
    lockTestAccess,
  );
  const error = await Effect.runPromise(
    Effect.flip(
      store.withLock("routes.lock", Effect.succeed("unused"), { timeoutMs: Number.POSITIVE_INFINITY }),
    ),
  );
  expect(error._tag).toBe("StateStoreError");
  expect(error.reason).toBe("lock");
  expect(error.remediation).toContain("finite plugin lock wait");
});

test("plugin options cannot override the live-owner lock policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-lock-policy-"));
  const lockDir = join(root, "locks");
  const lockPath = join(lockDir, "routes.lock.lock");
  const existing = JSON.stringify({
    pid: process.pid,
    token: "live-owner",
    createdAt: Date.now() - 60_000,
  });
  await mkdir(lockDir);
  await writeFile(lockPath, existing, { mode: 0o600 });
  try {
    const store = makePluginStateStore(makeTestStateStore().service, AbsolutePath.make(root), lockTestAccess);
    const callerOptions = { timeoutMs: 80, expireLiveOwner: true };
    const result = await Effect.runPromise(
      Effect.result(store.withLock("routes.lock", Effect.succeed("incorrect takeover"), callerOptions)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("StateStoreError");
      expect(result.failure.reason).toBe("lock");
    }
    expect(await readFile(lockPath, "utf8")).toBe(existing);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
