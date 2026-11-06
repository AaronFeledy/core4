import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateHandoffDir } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { Effect, Exit, Schema } from "effect";

import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { UpdateNetworkError } from "../../src/update/errors.ts";
import { makeUpdateHandoff } from "../../src/update/handoff.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("update replacement handoff", () => {
  test("preserves the abort reason alongside completed plugin receipts", async () => {
    // Given: plugin work succeeded but replacement was aborted.
    const handoff = makeUpdateHandoff(makeTestStateStore().service);
    const result = {
      updatedCore: false,
      updatedPlugins: ["fixture"],
      hasFailures: true,
      coreFailure: {
        tag: "UpdatePermissionError",
        message: "Plugin compatibility changed.",
        remediation: "The plugin set changed; re-run lando update.",
      },
    };
    // When: the next process consumes the receipt.
    const token = await Effect.runPromise(handoff.save(result));
    const receipt = await Effect.runPromise(handoff.consume(token));
    // Then: neither the failure nor completed work is lost.
    expect(receipt).toEqual(result);
  });
  test("stores a schema-versioned receipt and consumes it exactly once", async () => {
    const stateStore = makeTestStateStore();
    const handoff = makeUpdateHandoff(stateStore.service);
    const result = {
      updatedCore: true,
      updatedPlugins: ["@lando/plugin-php"],
      pluginResults: [
        {
          kind: "plugin" as const,
          name: "@lando/plugin-php",
          currentVersion: "1.0.0",
          targetVersion: "1.1.0",
          selector: "latest",
          status: "update" as const,
          reason: "selected" as const,
        },
      ],
      hasFailures: false,
    };

    const token = await Effect.runPromise(handoff.save(result));
    const first = await Effect.runPromise(handoff.consume(token));
    const second = await Effect.runPromise(handoff.consume(token));

    expect(token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first).toEqual(result);
    expect(second).toBeUndefined();
    expect(stateStore.snapshot().size).toBe(0);
  });

  test("a finished deferred receipt cannot be finished again or consumed as a one-shot", async () => {
    // Given: a Windows replacement already recorded success.
    const handoff = makeUpdateHandoff(makeTestStateStore().service);
    const token = await Effect.runPromise(handoff.saveDeferred({ updatedCore: false, updatedPlugins: [] }));
    await Effect.runPromise(handoff.finishDeferred(token));
    // When: a late failure path and the one-shot consumer reach the same receipt.
    const refinished = await Effect.runPromiseExit(
      handoff.finishDeferred(token, { tag: "UpdatePermissionError", message: "late", remediation: "retry" }),
    );
    const oneShot = await Effect.runPromise(handoff.consume(token));
    // Then: the recorded success survives for the deferred consumer.
    expect(Exit.isFailure(refinished)).toBe(true);
    expect(oneShot).toBeUndefined();
    expect(await Effect.runPromise(handoff.consumeDeferred(token))).toEqual({
      updatedCore: true,
      updatedPlugins: [],
    });
  });

  test("a one-shot receipt cannot be finished as a deferred replacement", async () => {
    const handoff = makeUpdateHandoff(makeTestStateStore().service);
    const result = { updatedCore: true, updatedPlugins: [] };
    const token = await Effect.runPromise(handoff.save(result));
    const refused = await Effect.runPromise(Effect.result(handoff.finishDeferred(token)));
    expect(refused._tag).toBe("Failure");
    if (refused._tag !== "Failure") throw new Error("Expected a refused finish");
    expect(refused.failure).toBeInstanceOf(UpdateNetworkError);
    expect(String(refused.failure.cause)).toContain("cannot finish-deferred while one-shot");
    expect(Exit.isFailure(await Effect.runPromiseExit(handoff.finishDeferred(crypto.randomUUID())))).toBe(
      true,
    );
    expect(await Effect.runPromise(handoff.consume(token))).toEqual(result);
  });

  test("a refused consume leaves the stored receipt bytes untouched", async () => {
    // Given a pending deferred receipt whose bytes differ from what a rewrite would emit.
    const stateStore = makeTestStateStore();
    const handoff = makeUpdateHandoff(stateStore.service);
    const token = await Effect.runPromise(handoff.saveDeferred({ updatedCore: false, updatedPlugins: [] }));
    const [saved] = [...stateStore.snapshot()];
    if (saved === undefined) throw new Error("Expected the saved receipt");
    const [file, bytes] = saved;
    const path = AbsolutePath.make(file);
    const stored = JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
    await Effect.runPromise(stateStore.writeRaw(path, stored));

    // When the one-shot consumer reaches the pending receipt.
    const consumed = await Effect.runPromise(handoff.consume(token));

    // Then it returns nothing and does not rewrite the receipt.
    expect(consumed).toBeUndefined();
    expect(new TextDecoder().decode(await Effect.runPromise(stateStore.readRaw(path)))).toBe(stored);
  });

  test("persists under userData and survives user cache deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-handoff-durable-"));
    roots.push(root);
    const cache = join(root, "cache");
    const data = Schema.decodeUnknownSync(AbsolutePath)(join(root, "data"));
    await Bun.write(join(cache, "disposable"), "scratch");
    const previous = {
      LANDO_USER_CACHE_ROOT: process.env.LANDO_USER_CACHE_ROOT,
      LANDO_USER_DATA_ROOT: process.env.LANDO_USER_DATA_ROOT,
      LANDO_USER_CONF_ROOT: process.env.LANDO_USER_CONF_ROOT,
    };
    process.env.LANDO_USER_CACHE_ROOT = cache;
    process.env.LANDO_USER_DATA_ROOT = data;
    process.env.LANDO_USER_CONF_ROOT = join(root, "conf");
    try {
      const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLayer.layer)));
      const handoff = makeUpdateHandoff(live);
      const result = {
        updatedCore: false,
        updatedPlugins: ["durable-plugin"],
        hasFailures: true,
        coreFailure: {
          tag: "UpdatePermissionError",
          message: "aborted",
          remediation: "retry",
        },
      };
      const token = await Effect.runPromise(handoff.save(result));
      const receiptPath = join(updateHandoffDir(data), `${token}.json`);
      await rm(cache, { recursive: true, force: true });
      expect(await Bun.file(receiptPath).exists()).toBe(true);
      const first = await Effect.runPromise(handoff.consume(token));
      const second = await Effect.runPromise(handoff.consume(token));
      expect(first).toEqual(result);
      expect(second).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
