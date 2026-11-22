import { Context } from "effect";

/**
 * What the current fiber is doing, for the diagnostic record an exclusive holder
 * writes so a waiter can say "Waiting for lando start in alpha". The CLI sets
 * `command`; app-scoped work sets `app`. Never used to decide anything.
 */
export interface LockHolderContext {
  readonly command?: string;
  readonly app?: string;
}

export const LockHolder = Context.Reference<LockHolderContext>("@lando/state-store/LockHolder", {
  defaultValue: (): LockHolderContext => ({}),
});

export const LOCK_HOLDER_LABEL_MAX = 128;
