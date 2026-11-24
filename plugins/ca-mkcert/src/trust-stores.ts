/**
 * Every trust store the mkcert authority manages, in one stable order: the system store, each Linux
 * browser (NSS) database, each Homebrew CA bundle, then the Windows store under WSL. `inspect` only
 * reads. `repair` runs after `mkcert -install` has written the system store: it re-reads that store,
 * adds the root to browser databases that lack it, rebuilds Homebrew bundles, and re-reads the
 * Windows store, which Lando never writes.
 */
import type { TrustStoreChange, TrustStoreStatus } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import { type HostEnv, makeHomebrewTrust } from "./homebrew-trust.ts";
import { type NssInspection, makeNssTrust } from "./nss-trust.ts";
import { makeSystemTrust } from "./system-trust.ts";
import { type WindowsTrustPaths, makeWindowsTrust } from "./windows-trust.ts";

const storeKey = ({ id, location }: TrustStoreStatus): string => JSON.stringify([id, location ?? null]);

/** `after`, each row marked changed when setup took it from not trusted to trusted. */
export const markChanges = (
  before: ReadonlyArray<TrustStoreStatus>,
  after: ReadonlyArray<TrustStoreStatus>,
): ReadonlyArray<TrustStoreChange> => {
  const trustedBefore = new Set(before.filter(({ state }) => state === "trusted").map(storeKey));
  return after.map((row) => ({
    ...row,
    changed: row.state === "trusted" && !trustedBefore.has(storeKey(row)),
  }));
};

export interface TrustStoresOptions {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly env: HostEnv;
  readonly platform: string;
  readonly linuxSystemBundles?: ReadonlyArray<string> | undefined;
  readonly windowsPaths: WindowsTrustPaths;
}

export interface TrustStoresSnapshot {
  readonly rows: ReadonlyArray<TrustStoreStatus>;
  readonly nss: ReadonlyArray<NssInspection>;
}

export const makeTrustStores = ({
  processRunner,
  env,
  platform,
  linuxSystemBundles,
  windowsPaths,
}: TrustStoresOptions) => {
  const system = makeSystemTrust({ processRunner, platform, linuxBundles: linuxSystemBundles });
  const nss = makeNssTrust({ processRunner, env, platform });
  const homebrew = makeHomebrewTrust({ processRunner, env, platform });
  const windows = makeWindowsTrust({ processRunner, env, platform, paths: windowsPaths });

  const snapshot = Effect.fnUntraced(function* (caroot: string, root: string) {
    const systemRow = yield* system.inspect(caroot, root);
    const nssRows = yield* nss.inspect(root);
    const homebrewRows = yield* homebrew.inspect(root);
    const windowsRows = yield* windows.inspect(caroot, root);
    return {
      rows: [systemRow, ...nssRows.map(({ status }) => status), ...homebrewRows, ...windowsRows],
      nss: nssRows,
    } satisfies TrustStoresSnapshot;
  });

  return {
    snapshot,
    /** Every managed store. Reads only. */
    inspect: (caroot: string, root: string) => Effect.map(snapshot(caroot, root), ({ rows }) => rows),
    /** The stores after setup's repairs; `before` is the snapshot taken before `mkcert -install`. */
    repair: Effect.fnUntraced(function* (caroot: string, root: string, before: TrustStoresSnapshot) {
      // mkcert can exit 0 without the system store trusting the root; that is reported, not fatal.
      const systemRow = yield* system.inspect(caroot, root);
      const nssRows = yield* nss.install(caroot, root, before.nss);
      const homebrewRows = yield* homebrew.refresh(root, systemRow.state === "trusted");
      const windowsRows = yield* windows.inspect(caroot, root);
      return [systemRow, ...nssRows.map(({ status }) => status), ...homebrewRows, ...windowsRows];
    }),
  };
};
