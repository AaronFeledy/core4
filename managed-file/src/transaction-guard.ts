import { resolveLandoRoots } from "@lando/paths";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
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
  return ManagedFileTransactionGuard.of({
    ensureConsistent: recovery.ensureConsistent,
    pending: recovery.pending,
  });
};

export const layerWithPrivateFileAccess: Layer.Layer<
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

export const layer: Layer.Layer<ManagedFileTransactionGuard> = layerWithPrivateFileAccess.pipe(
  Layer.provide(PrivateFileAccessService.layer),
);
