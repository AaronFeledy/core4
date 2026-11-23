import { Schema } from "effect";
import { AppliedAppPlan } from "./app-plan.ts";
import { AppId } from "./primitives.ts";

const appliedStateLocation = {
  appId: Schema.optionalKey(
    AppId.annotate({
      description: "Protected app ID; absent when an aggregate record protects every app on this provider.",
    }),
  ),
  path: Schema.String.annotate({ description: "Protected applied-state record path." }),
};
export const UnreadableAppliedState = Schema.Union([
  Schema.Struct({
    ...appliedStateLocation,
    reason: Schema.Literal("unreadable").annotate({ description: "The record cannot be decoded." }),
  }),
  Schema.Struct({
    ...appliedStateLocation,
    reason: Schema.Literal("newer-version").annotate({ description: "The record uses a newer format." }),
    storedVersion: Schema.Int.annotate({ description: "Applied-state envelope version on disk." }),
    supportedVersion: Schema.Int.annotate({
      description: "Applied-state envelope version this Lando supports.",
    }),
  }),
]);
export type UnreadableAppliedState = typeof UnreadableAppliedState.Type;

export const AppliedStateInventory = Schema.Struct({
  plans: Schema.Array(AppliedAppPlan).annotate({ description: "Readable applied provider plans." }),
  unreadable: Schema.Array(UnreadableAppliedState).annotate({
    description: "State records whose ownership claims must remain protected.",
  }),
});
export type AppliedStateInventory = typeof AppliedStateInventory.Type;
