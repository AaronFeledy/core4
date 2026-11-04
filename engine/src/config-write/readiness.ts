import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";

export const assertConfigReadable = Effect.fnUntraced(function* (appRoot: string) {
  const inputs = yield* scopedLandofileRuntimeInputs;
  const provided = yield* Effect.serviceOption(ManagedFileTransactionGuard);
  const guard = inputs.transactionGuard ?? Option.getOrUndefined(provided);
  if (guard !== undefined) yield* guard.assertReadable(appRoot);
});
