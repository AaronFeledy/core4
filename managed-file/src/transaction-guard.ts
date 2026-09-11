import { resolveLandoRoots } from "@lando/paths";
import { ManagedFileTransactionGuard, ProcessRunner } from "@lando/sdk/services";
import { type PrivateFileAccess, makeOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { makeTransactionRecovery } from "./transaction-recovery.ts";

/**
 * The thin guard native loading and `start` consult before reading a possibly
 * partial file set. It inspects the app-root journal, recovers an incomplete
 * transaction, cleans up a committed one, and refuses a `blocked` one. It loads
 * no translator and renders no migration UI.
 */
export const makeManagedFileTransactionGuard = (options: {
  readonly journalRoot: () => string;
  readonly privateFileAccess?: PrivateFileAccess;
}) => {
  const recovery = makeTransactionRecovery({
    journalRoot: options.journalRoot,
    ...(options.privateFileAccess === undefined ? {} : { privateFileAccess: options.privateFileAccess }),
  });
  return { ensureConsistent: recovery.ensureConsistent, pending: recovery.pending };
};

export const ManagedFileTransactionGuardLive: Layer.Layer<ManagedFileTransactionGuard, never, ProcessRunner> =
  Layer.effect(
    ManagedFileTransactionGuard,
    Effect.map(ProcessRunner, (processRunner) =>
      makeManagedFileTransactionGuard({
        journalRoot: () => resolveLandoRoots().userDataRoot,
        privateFileAccess: makeOwnerOnlyFileAccess({ processRunner }),
      }),
    ),
  );
