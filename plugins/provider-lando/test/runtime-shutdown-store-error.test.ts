import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";
import { makeRuntimeShutdownStore } from "../src/runtime-shutdown.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const upgrade =
  "A newer Lando wrote runtime-shutdown.json (envelope version 5; this Lando supports 1). Run the newer Lando or upgrade. Leave the file in place.";

test("runtime shutdown store maps newer-version with upgrade remediation", async () => {
  const memory = makeTestStateStore();
  const base = makePluginStateStore(
    memory.service,
    AbsolutePath.make(join(tmpdir(), randomUUID())),
    ownerOnlyFileAccess,
  );
  const store = {
    ...base,
    open: () =>
      Effect.fail(
        new StateStoreError({
          reason: "newer-version",
          operation: "open",
          path: "runtime-shutdown.json",
          storedVersion: 5,
          supportedVersion: 1,
          remediation: upgrade,
        }),
      ),
  };
  const exit = await Effect.runPromiseExit(makeRuntimeShutdownStore(store as typeof base));
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  expect(error).toBeInstanceOf(ProviderUnavailableError);
  expect((error as ProviderUnavailableError).remediation).toBe(upgrade);
  expect((error as ProviderUnavailableError).operation).toBe("runtimeShutdown");
});
