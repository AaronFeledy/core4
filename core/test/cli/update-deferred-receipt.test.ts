import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeUpdateHandoff } from "@lando/engine/operations/update";
import { AbsolutePath } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect, Schema } from "effect";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("detached helper persists an abort which the next real invocation surfaces once", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-deferred-receipt-"));
  roots.push(root);
  const cache = Schema.decodeUnknownSync(AbsolutePath)(join(root, "cache"));
  const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
  const isolated: StateStoreShape = { open: (spec) => live.open({ ...spec, root: { path: cache } }) };
  const handoff = makeUpdateHandoff(isolated);
  const token = await Effect.runPromise(
    handoff.saveDeferred({
      updatedCore: false,
      updatedPlugins: ["completed-plugin"],
      pluginResults: [
        {
          kind: "plugin",
          name: "completed-plugin",
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          status: "update",
          reason: "selected",
        },
      ],
    }),
  );
  const executablePath = join(root, "lando.exe");
  const stagedBinaryPath = join(root, "candidate.exe");
  await writeFile(executablePath, "old");
  await writeFile(stagedBinaryPath, "new");
  await writeFile(join(root, "registry.json"), "corrupt");
  const requestPath = join(root, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      executablePath,
      stagedBinaryPath,
      backupPath: `${executablePath}.bak`,
      token,
      parentPid: 2147483647,
      precondition: { pluginsRoot: root, currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0" },
    }),
  );
  const env = {
    ...process.env,
    LANDO_USER_CACHE_ROOT: cache,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
  };
  const cli = resolve("core/bin/lando.ts");
  const helper = Bun.spawn([process.execPath, cli, "--lando-update-replacement", requestPath], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const helperError = await new Response(helper.stderr).text();
  expect(await helper.exited).toBe(1);
  expect(helperError).toBe("");
  expect(await Bun.file(executablePath).text()).toBe("old");
  const invoke = async () => {
    const child = Bun.spawn([process.execPath, cli, "--version"], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  const next = await invoke();
  expect(next.exit).toBe(0);
  expect(next.stdout.trim()).not.toBe("");
  expect(next.stderr).toContain("core: failed");
  expect(next.stderr).toContain("re-run lando update");
  expect(next.stderr).toContain("completed-plugin");
  expect((await invoke()).stderr).toBe("");
});
