import { afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, type Scope } from "effect";
import { type TransactionOptions, makeManagedFileTransactions } from "../src/transaction.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
export const fixture = async (
  checkpoint?: TransactionOptions["checkpoint"],
  privateFileAccess?: PrivateFileAccess,
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-transaction-")));
  roots.push(root);
  const appRoot = join(root, "app");
  const dataRoot = join(root, "data");
  await mkdir(appRoot);
  await mkdir(dataRoot);
  return {
    root,
    appRoot,
    dataRoot,
    transactions: makeManagedFileTransactions({
      journalRoot: () => dataRoot,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(privateFileAccess === undefined ? {} : { privateFileAccess }),
    }),
  };
};
export const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));
