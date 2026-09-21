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

const isolatedStore = (live: StateStoreShape, cache: AbsolutePath): StateStoreShape => ({
  ...live,
  open: (spec) => live.open({ ...spec, root: { path: cache } }),
});

test("detached helper persists an abort which the next real invocation surfaces once", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-deferred-receipt-"));
  roots.push(root);
  const cache = Schema.decodeUnknownSync(AbsolutePath)(join(root, "cache"));
  const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
  const isolated = isolatedStore(live, cache);
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
    LANDO_UPDATE_HANDOFF_TOKEN: token,
    LANDO_USER_CACHE_ROOT: cache,
    LANDO_USER_DATA_ROOT: join(root, "data"),
    LANDO_USER_CONF_ROOT: join(root, "conf"),
  };
  const cli = resolve("core/bin/lando.ts");
  const helper = Bun.spawn([process.execPath, cli, "--lando-update-replacement", requestPath, token], {
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const helperError = await new Response(helper.stderr).text();
  expect(await helper.exited).toBe(1);
  expect(helperError).toBe("");
  expect(await Bun.file(executablePath).text()).toBe("old");
  const invoke = async (argv: string[] = ["--version"]) => {
    const child = Bun.spawn([process.execPath, cli, ...argv], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  const receiptPath = join(cache, "update-handoff", `${token}.json`);
  const before = await Bun.file(receiptPath).text();
  const dryRun = await invoke(["update", "--only=plugins", "--dry-run", "--format=json"]);
  expect(dryRun.exit).toBe(0);
  expect(await Bun.file(receiptPath).text()).toBe(before);
  const next = await invoke();
  expect(next.exit).toBe(1);
  expect(next.stdout).toContain("core: failed");
  expect(next.stdout).toContain("re-run lando update");
  expect(next.stdout).toContain("completed-plugin");
  const following = await invoke();
  expect(following.exit).toBe(0);
  expect(following.stderr).toBe("");
  expect(following.stdout).not.toContain("completed-plugin");
});

test.each(["json", "yaml", "ndjson"])(
  "deferred failures survive a %s request until surfaced in a supported format",
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), "lando-deferred-format-"));
    roots.push(root);
    const cache = Schema.decodeUnknownSync(AbsolutePath)(join(root, "cache"));
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
    const handoff = makeUpdateHandoff(isolatedStore(live, cache));
    const token = await Effect.runPromise(
      handoff.saveDeferred({ updatedCore: false, updatedPlugins: ["completed"] }),
    );
    await Effect.runPromise(
      handoff.finishDeferred(token, {
        tag: "UpdatePermissionError",
        message: "Replacement aborted",
        remediation: "Retry update",
      }),
    );
    const invoke = async (requestedFormat: string) => {
      const child = Bun.spawn(
        [process.execPath, resolve("core/bin/lando.ts"), "meta:version", `--format=${requestedFormat}`],
        {
          env: {
            ...process.env,
            LANDO_USER_CACHE_ROOT: cache,
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exit };
    };
    const receiptPath = join(cache, "update-handoff", `${token}.json`);
    if (format === "ndjson") {
      const before = await Bun.file(receiptPath).text();
      const rejected = await invoke("ndjson");
      expect(rejected.exit).toBe(2);
      expect(rejected.stderr).toBe("");
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        ok: false,
        command: "meta:version",
        error: {
          _tag: "RendererSelectionError",
          message: 'meta:version does not support result format "ndjson". Allowed: text, json, yaml.',
        },
      });
      expect(await Bun.file(receiptPath).text()).toBe(before);
    }
    const { stdout, stderr, exit } = await invoke(format === "ndjson" ? "json" : format);
    expect(exit).toBe(1);
    expect(stderr).toBe("");
    const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
      format === "yaml" ? Bun.YAML.parse(stdout) : JSON.parse(stdout),
    );
    const result = envelope.result;
    expect(result).toMatchObject({
      updatedCore: false,
      hasFailures: true,
      updatedPlugins: ["completed"],
      coreFailure: { tag: "UpdatePermissionError" },
    });
    expect(await Bun.file(receiptPath).exists()).toBe(false);
  },
);

test.each(["missing", "malformed", "invalid-schema"])(
  "helper request %s failure finalizes the pending receipt",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "lando-deferred-early-failure-"));
    roots.push(root);
    const cache = Schema.decodeUnknownSync(AbsolutePath)(join(root, "cache"));
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
    const handoff = makeUpdateHandoff(isolatedStore(live, cache));
    const token = await Effect.runPromise(
      handoff.saveDeferred({ updatedCore: false, updatedPlugins: ["completed"] }),
    );
    const binary = join(root, "lando.exe");
    await writeFile(binary, "old");
    const requestPath = join(root, "request.json");
    if (failure !== "missing") await writeFile(requestPath, failure === "malformed" ? "{" : "{}");
    const child = Bun.spawn(
      [process.execPath, resolve("core/bin/lando.ts"), "--lando-update-replacement", requestPath, token],
      {
        env: {
          ...process.env,
          LANDO_USER_CACHE_ROOT: cache,
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    const receipt = await Effect.runPromise(handoff.consumeDeferred(token));
    expect(receipt).toMatchObject({
      updatedCore: false,
      hasFailures: true,
      updatedPlugins: ["completed"],
      coreFailure: { tag: "UpdatePermissionError" },
    });
    expect(await Bun.file(binary).text()).toBe("old");
  },
);
