import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { PortablePath } from "@lando/sdk/schema";

import { makeLandoPluginContext } from "../../src/plugins/context.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runScoped = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));
const exit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

const pluginFile = (id: string, path: string) =>
  ({
    id,
    path: path as PortablePath,
    mode: "file" as const,
    format: "text" as const,
    content: { kind: "text" as const, value: "managed\n" },
  }) as const;

describe("LandoPluginContext managed files ownership scoping", () => {
  test("a plugin's managed files are recorded with its own owner id", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]?.owner).toBe("plugin-a");
  });

  test("a plugin's status only sees its own files", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });
    const b = makeLandoPluginContext({ id: "plugin-b", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    const aStatus = await run(a.managedFiles.status);
    const bStatus = await run(b.managedFiles.status);
    expect(aStatus.map((info) => info.path)).toEqual(["cfg.txt"]);
    expect(bStatus).toEqual([]);
  });

  test("a plugin cannot apply over a path owned by another plugin", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });
    const b = makeLandoPluginContext({ id: "plugin-b", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    const result = await exit(Effect.scoped(b.managedFiles.apply([pluginFile("b:cfg", "cfg.txt")])));
    expect(result._tag).toBe("Failure");
    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]?.owner).toBe("plugin-a");
  });

  test("a plugin cannot apply over another owner's path through an equivalent path spelling", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });
    const b = makeLandoPluginContext({ id: "plugin-b", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    const result = await exit(
      Effect.scoped(
        b.managedFiles.apply([
          {
            ...pluginFile("b:cfg", "./cfg.txt"),
            marker: "a:cfg",
            onConflict: "overwrite",
            content: { kind: "text", value: "plugin-b overwrite\n" },
          },
        ]),
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]?.owner).toBe("plugin-a");
    expect(store.read("cfg.txt")).toContain("managed\n");
    expect(store.read("cfg.txt")).not.toContain("plugin-b overwrite");
  });

  test("a plugin cannot remove, adopt, or release another plugin's file", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });
    const b = makeLandoPluginContext({ id: "plugin-b", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    const removed = await exit(b.managedFiles.remove({ path: "cfg.txt" as PortablePath }));
    const adopted = await exit(b.managedFiles.adopt("cfg.txt" as PortablePath));
    const released = await exit(b.managedFiles.release("cfg.txt" as PortablePath));
    expect(removed._tag).toBe("Failure");
    expect(adopted._tag).toBe("Failure");
    expect(released._tag).toBe("Failure");

    expect(store.read("cfg.txt")).not.toBeNull();
    const aStatus = await run(a.managedFiles.status);
    expect(aStatus[0]?.state).toBe("managed");
  });

  test("a plugin can manage its own files end to end", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));
    const removed = await run(a.managedFiles.remove({ path: "cfg.txt" as PortablePath }));

    expect(removed.entries).toHaveLength(1);
    expect(store.read("cfg.txt")).toBeNull();
  });

  test("an explicitly declared remove base is rejected, not allowed to miss the plugin ledger entry", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });

    await runScoped(a.managedFiles.apply([pluginFile("a:cfg", "cfg.txt")]));

    const result = await exit(
      a.managedFiles.remove({ path: "cfg.txt" as PortablePath, base: "/other/app" } as unknown as {
        readonly path: PortablePath;
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(store.ledger()).toHaveLength(1);
    expect(store.read("cfg.txt")).not.toBeNull();
  });

  test("an explicitly declared foreign owner is rejected, not coerced", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });

    const foreign = { ...pluginFile("a:cfg", "cfg.txt"), owner: "someone-else" };
    const result = await exit(
      Effect.scoped(a.managedFiles.apply([foreign as unknown as ReturnType<typeof pluginFile>])),
    );

    expect(result._tag).toBe("Failure");
    expect(store.ledger()).toHaveLength(0);
  });

  test("an explicitly declared base is rejected, not recorded", async () => {
    const store = await run(makeTestManagedFileStore());
    const a = makeLandoPluginContext({ id: "plugin-a", managedFileService: store.service });

    const withBase = { ...pluginFile("a:cfg", "cfg.txt"), base: "/other/app" };
    const result = await exit(
      Effect.scoped(a.managedFiles.apply([withBase as unknown as ReturnType<typeof pluginFile>])),
    );

    expect(result._tag).toBe("Failure");
    expect(store.ledger()).toHaveLength(0);
  });
});
