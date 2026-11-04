import { Schema } from "effect";
import { AppPlan } from "./app-plan.ts";
import { AppId } from "./primitives.ts";

export const UnreadableAppliedState = Schema.Struct({
  appId: Schema.optionalKey(
    AppId.annotate({
      description: "Protected app ID; absent when an aggregate record protects every app on this provider.",
    }),
  ),
  path: Schema.String.annotate({ description: "Unreadable applied-state record path." }),
});
export type UnreadableAppliedState = typeof UnreadableAppliedState.Type;

export const AppliedStateInventory = Schema.Struct({
  plans: Schema.Array(AppPlan).annotate({ description: "Readable applied provider plans." }),
  unreadable: Schema.Array(UnreadableAppliedState).annotate({
    description: "State records whose ownership claims must remain protected.",
  }),
});
export type AppliedStateInventory = typeof AppliedStateInventory.Type;
