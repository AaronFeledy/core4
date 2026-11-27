import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { readJournal } from "../../src/operations/accelerated-start-journal.ts";

const newerCause = new StateStoreError({
  reason: "newer-version",
  operation: "get",
  path: "/data/accelerated-starts/deadbeef.json",
  storedVersion: 9,
  supportedVersion: 2,
  remediation:
    "State at /data/accelerated-starts/deadbeef.json was written by a newer Lando (envelope version 9; this Lando supports 2). Run that newer Lando or upgrade. Leave the file in place.",
});

test("accelerated-start journal keeps newer-version upgrade remediation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-journal-newer-"));
  try {
    const openFails = Layer.succeed(
      StateStore,
      StateStore.of({
        withLock: (_key, body) => body,
        open: () => Effect.fail(newerCause),
      }),
    );
    const app = { kind: "user" as const, id: AppId.make("demo"), root: AbsolutePath.make(root) };
    const result = await Effect.runPromise(Effect.result(readJournal(app).pipe(Effect.provide(openFails))));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "FileSyncStartError",
        remediation: newerCause.remediation,
        cause: newerCause,
      },
    });
    const failure = result._tag === "Failure" ? result.failure : undefined;
    expect(failure?.remediation.toLowerCase()).not.toContain("lando stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
