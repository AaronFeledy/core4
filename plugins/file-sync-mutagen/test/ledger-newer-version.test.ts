import { expect, test } from "bun:test";
import { FileSyncStartError, StateStoreError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Cause, Effect, Exit, Option } from "effect";
import { hasDurableMutagenOwnership } from "../src/mutagen-process-client.ts";
import { privateFileAccess } from "./support/mutagen-process.ts";

const upgrade =
  "A newer Lando wrote mutagen.json (envelope version 3; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place.";

test("hasDurableMutagenOwnership preserves newer-version upgrade remediation", async () => {
  const memory = makeTestStateStore();
  const base = makePluginStateStore(memory.service, AbsolutePath.make("/tmp/mutagen-nv"), privateFileAccess);
  const store: PluginStateStore = {
    open: base.open,
    withLock: <A, E>(_key: string, _body: Effect.Effect<A, E>) =>
      Effect.fail(
        new StateStoreError({
          reason: "newer-version",
          operation: "get",
          path: "mutagen.json",
          storedVersion: 3,
          supportedVersion: 1,
          remediation: upgrade,
        }),
      ) as Effect.Effect<A, E | StateStoreError>,
  };
  const exit = await Effect.runPromiseExit(hasDurableMutagenOwnership(store));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(FileSyncStartError);
  expect((error as FileSyncStartError).remediation).toBe(upgrade);
  expect((error as FileSyncStartError).cause).toMatchObject({ reason: "newer-version" });
});
