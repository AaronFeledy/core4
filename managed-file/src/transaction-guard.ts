import { resolveLandoRoots } from "@lando/paths";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import {
  type PrivateFileAccess,
  PrivateFileAccessLive,
  PrivateFileAccessService,
} from "@lando/state-store/private-file-access";
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
  readonly privateFileAccess: PrivateFileAccess;
}) => {
  const recovery = makeTransactionRecovery({
    journalRoot: options.journalRoot,
    privateFileAccess: options.privateFileAccess,
  });
  return { ensureConsistent: recovery.ensureConsistent, pending: recovery.pending };
};

export const ManagedFileTransactionGuardWithPrivateFileAccessLive: Layer.Layer<
  ManagedFileTransactionGuard,
  never,
  PrivateFileAccessService
> = Layer.effect(
  ManagedFileTransactionGuard,
  Effect.map(PrivateFileAccessService, (privateFileAccess) =>
    makeManagedFileTransactionGuard({
      journalRoot: () => resolveLandoRoots().userDataRoot,
      privateFileAccess,
    }),
  ),
);

export const ManagedFileTransactionGuardLive: Layer.Layer<ManagedFileTransactionGuard> =
  ManagedFileTransactionGuardWithPrivateFileAccessLive.pipe(Layer.provide(PrivateFileAccessLive));
