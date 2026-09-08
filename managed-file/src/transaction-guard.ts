import { resolveLandoRoots } from "@lando/paths";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Layer } from "effect";
import { makeTransactionRecovery } from "./transaction-recovery.ts";

/**
 * The thin guard native loading and `start` consult before reading a possibly
 * partial file set. It inspects the app-root journal, recovers an incomplete
 * transaction, cleans up a committed one, and refuses a `blocked` one. It loads
 * no translator and renders no migration UI.
 */
export const makeManagedFileTransactionGuard = (options: { readonly journalRoot: () => string }) => {
  const recovery = makeTransactionRecovery({ journalRoot: options.journalRoot });
  return { ensureConsistent: recovery.ensureConsistent, pending: recovery.pending };
};

export const ManagedFileTransactionGuardLive: Layer.Layer<ManagedFileTransactionGuard> = Layer.succeed(
  ManagedFileTransactionGuard,
  makeManagedFileTransactionGuard({ journalRoot: () => resolveLandoRoots().userDataRoot }),
);
