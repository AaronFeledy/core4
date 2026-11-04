import { resolveLandoRoots } from "@lando/paths";
import { ManagedFileTransactionGuard, PathsService } from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { transactionError } from "./transaction-error.ts";
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
    assertReadable: Effect.fn("ManagedFileTransactionGuard.assertReadable")(function* (appRoot: string) {
      const report = yield* recovery.pending(appRoot);
      if (report === null) return;
      switch (report.state) {
        case "committed":
          return;
        case "prepared":
        case "committing":
          return yield* Effect.fail(transactionError("pending-transaction", "inspect", appRoot));
        case "blocked":
          return yield* Effect.fail(transactionError("blocked", "inspect", appRoot));
        default: {
          const exhaustive: never = report.state;
          return exhaustive;
        }
      }
    }),
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
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    const paths = yield* Effect.serviceOption(PathsService);
    const root = paths._tag === "Some" ? paths.value.roots.userDataRoot : resolveLandoRoots().userDataRoot;
    return makeManagedFileTransactionGuard({
      journalRoot: () => root,
      privateFileAccess,
    });
  }),
);

export const layer: Layer.Layer<ManagedFileTransactionGuard> = layerWithPrivateFileAccess.pipe(
  Layer.provide(PrivateFileAccessService.layer),
);
