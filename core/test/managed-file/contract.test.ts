import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { AbsolutePath } from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import type { LandoEvent } from "@lando/sdk/services";
import { type ManagedFileContractHarness, runManagedFileContract } from "@lando/sdk/test";

import { makeDiskBackend, makeManagedFileService } from "../../src/managed-file/service.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("ManagedFileService contract suite", () => {
  test("TestManagedFileStore (in-memory) satisfies the contract", async () => {
    const store = await run(makeTestManagedFileStore());
    const harness: ManagedFileContractHarness = {
      name: "TestManagedFileStore",
      service: store.service,
      base: store.base as AbsolutePath,
      read: (path) => Effect.sync(() => store.read(path)),
      seed: (path, content) => Effect.sync(() => store.seed(path, content)),
      events: () => Effect.sync(() => store.events()),
    };

    const result = await run(runManagedFileContract(harness));
    expect(result).toBeUndefined();
  });

  test("the disk-backed live ManagedFileService satisfies the contract", async () => {
    const base = (await realpath(await mkdtemp(join(tmpdir(), "lando-mfc-base-")))) as AbsolutePath;
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mfc-data-")));
    const captured: Array<LandoEvent> = [];
    const { redact } = createSecretRedactor([]);

    try {
      const service = await run(
        makeDiskBackend({ defaultBase: () => base, ledgerRoot: () => dataRoot }).pipe(
          Effect.flatMap((backend) =>
            makeManagedFileService(backend, {
              redactText: redact,
              publish: (event) => Effect.sync(() => void captured.push(event)),
            }),
          ),
        ),
      );

      const harness: ManagedFileContractHarness = {
        name: "ManagedFileServiceLive (disk)",
        service,
        base,
        read: (path) =>
          Effect.promise(async () => {
            try {
              return (await readFile(join(base, path), "utf8")) as string;
            } catch {
              return null;
            }
          }),
        seed: (path, content) =>
          Effect.promise(async () => {
            await mkdir(dirname(join(base, path)), { recursive: true });
            await writeFile(join(base, path), content);
          }),
        events: () => Effect.sync(() => [...captured]),
      };

      const result = await run(runManagedFileContract(harness));
      expect(result).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
