import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { GlobalAppError } from "@lando/sdk/errors";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";

import { readGlobalPolicy } from "./enablement.ts";

/** Verify saved intent directly: a nested command can save policy before generation fails. */
export const captureGlobalStartupAdmission = Effect.fn("GlobalApp.captureStartupAdmission")(function* () {
  const store = yield* StateStore;
  const expected = sha256Hex(canonicalJson(yield* readGlobalPolicy()));
  return Effect.gen(function* () {
    const current = sha256Hex(canonicalJson(yield* readGlobalPolicy()));
    if (current !== expected)
      return yield* Effect.fail(
        new GlobalAppError({
          operation: "startup-admission",
          message: "Global service policy changed after this command planned its services.",
          remediation:
            "Repeat the command to load the current policy. Run `lando global:list` to inspect enabled services.",
        }),
      );
  }).pipe(Effect.provideService(StateStore, store));
});
