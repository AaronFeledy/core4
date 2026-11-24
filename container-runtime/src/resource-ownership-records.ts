import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { isPathWithin, makeLandoPaths } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { isErrnoCode } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { realpathOrDeepestExisting } from "@lando/state-store/paths";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import type { AdoptionReceipt, DataRootOwnershipContext } from "./data-root-ownership.ts";
import { makeResourceOwnershipStore, ownershipFailure } from "./resource-ownership.ts";
import { RESOURCE_OWNERSHIP_NAMESPACE } from "./resource-ownership-inventory.ts";

const inventoryDir = (pluginStateRoot: string) => join(pluginStateRoot, RESOURCE_OWNERSHIP_NAMESPACE);

const listRecords = (dir: string) =>
  Effect.tryPromise({
    try: () => readdir(dir),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(
      (cause: unknown) => isErrnoCode(cause, "ENOENT"),
      () => Effect.succeed([]),
    ),
    Effect.map((entries) => entries.filter((name) => name.endsWith(".json")).sort()),
  );

export const hasResourceOwnershipRecords = (providerId: string, pluginStateRoot: string) =>
  listRecords(inventoryDir(pluginStateRoot)).pipe(
    mapFailures((cause) => ownershipFailure(providerId, cause)),
    Effect.map((entries) => entries.length > 0),
  );

export const readDataRootAdoptionReceipts = Effect.fn("ResourceOwnership.readDataRootAdoptionReceipts")(
  function* (providerId: string, input: { readonly dataRoot: string; readonly pluginId: string }) {
    const { dataRoot } = input;
    const paths = makeLandoPaths({
      userDataRoot: dataRoot,
      platform: sep === "\\" ? "win32" : "linux",
      sources: { user: false, env: false },
    });
    const pluginRoot = AbsolutePath.make(paths.pluginStateDir(input.pluginId));
    const dir = inventoryDir(pluginRoot);
    const resolved = yield* Effect.tryPromise({
      try: () => realpathOrDeepestExisting(dir),
      catch: (cause) => ownershipFailure(providerId, cause),
    });
    if (!isPathWithin(dataRoot, resolved)) return yield* Effect.fail(ownershipFailure(providerId));
    const records = yield* listRecords(dir).pipe(mapFailures((cause) => ownershipFailure(providerId, cause)));
    if (records.length === 0) return { dataRoot, receipts: [] } satisfies DataRootOwnershipContext;

    const access = yield* PrivateFileAccessService;
    const state = makePluginStateStore(makeStateStore({ privateFileAccess: access }), pluginRoot, access);
    const store = makeResourceOwnershipStore(providerId, state);
    const receipts: AdoptionReceipt[] = [];
    for (const record of records) {
      const inventory = yield* store.loadRecord(record);
      for (const batch of inventory?.adoptions ?? []) {
        if (batch.dataRoot === dataRoot) receipts.push(...batch.receipts);
      }
    }
    return { dataRoot, receipts } satisfies DataRootOwnershipContext;
  },
  Effect.provide(PrivateFileAccessService.layer),
);
