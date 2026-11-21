import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

// Advisory lock waits: a command announces what it waits for and who holds it.

/** The holder's diagnostic record, read when the wait was announced. */
export const LockWaitHolder = Schema.Struct({
  pid: Schema.Int.annotate({ description: "Process id of the command holding the lock." }),
  command: Schema.optional(Schema.String).annotate({
    description: "How the holding command was invoked, for example `lando start`, when it recorded one.",
  }),
  app: Schema.optional(Schema.String).annotate({
    description: "Name of the app the holding command was working on, when it recorded one.",
  }),
  heldMs: Schema.Int.annotate({ description: "How long the holder has held the lock, in milliseconds." }),
}).annotate({
  identifier: "LockWaitHolder",
  description: "The command that holds an advisory lock another command is waiting for.",
});
export type LockWaitHolder = typeof LockWaitHolder.Type;

/**
 * A command is waiting for an advisory lock. Published once after a second of
 * waiting, then as reminders; the wait itself is bounded and fails with a
 * tagged lock error when its budget runs out.
 */
export const LockWaitEvent = Schema.TaggedStruct("lock.wait", {
  resource: Schema.String.annotate({
    description: "What the command is waiting for, for example `volume lando-cache-composer` or `app alpha`.",
  }),
  subject: Schema.Literals(["app", "resource"]).annotate({
    description:
      "`app` when the lock stands for a whole app, so the wait ends when the holding command finishes; `resource` otherwise.",
  }),
  holder: Schema.optional(LockWaitHolder).annotate({
    description:
      "The exclusive holder, when it left a readable record. Absent while shared holders (several commands using the resource) block the wait.",
  }),
  reminder: Schema.Boolean.annotate({
    description: "False for the first notice of a wait, true for later reminders.",
  }),
  remainingMs: Schema.Int.annotate({
    description: "Milliseconds left before the command gives up waiting.",
  }),
  timestamp: Timestamp,
}).annotate({
  identifier: "LockWaitEvent",
  description: "A command is waiting for an advisory lock another Lando command holds.",
});
export type LockWaitEvent = typeof LockWaitEvent.Type;
