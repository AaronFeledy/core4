import type { DataTransferError } from "@lando/sdk/errors";
import type { DataTransferSpec } from "@lando/sdk/schema";
import { Context, type Effect } from "effect";

/** Applies only to the exact transfer that owns the source admission. */
export const HostTreeCopyGuard = Context.Reference<
  | {
      readonly transfer: DataTransferSpec;
      readonly verify: Effect.Effect<void, DataTransferError>;
    }
  | undefined
>("@lando/data-mover/HostTreeCopyGuard", { defaultValue: () => undefined });
