import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { makeLandoRuntime } from "@lando/core";
import type { ManagedFile } from "@lando/core/schema";
import { ManagedFileService } from "@lando/core/services";

describe("library makeLandoRuntime managed-file surface", () => {
  test("applies a managed file under an isolated base and re-reads status", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-lib-mf-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-lib-mf-data-")));
    const previous = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_DATA_ROOT = dataRoot;

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const managed = yield* ManagedFileService;
          const file: ManagedFile = {
            id: "host:settings",
            owner: "embedding-host",
            path: "settings.txt",
            mode: "file",
            format: "text",
            content: { kind: "text", value: "managed by host\n" },
            base: base as ManagedFile["base"],
          };
          const applied = yield* Effect.scoped(managed.apply([file]));
          const status = yield* managed.status;
          return { applied, status };
        }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" }))),
      );

      expect(result.applied.entries[0]?.action).toBe("create");
      expect(
        result.status.some(
          (info) =>
            info.path === "settings.txt" && info.owner === "embedding-host" && info.state === "managed",
        ),
      ).toBe(true);
      expect(await readFile(join(base, "settings.txt"), "utf8")).toContain("managed by host");
    } finally {
      if (previous === undefined) {
        process.env.LANDO_USER_DATA_ROOT = "";
        Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      } else {
        process.env.LANDO_USER_DATA_ROOT = previous;
      }
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
