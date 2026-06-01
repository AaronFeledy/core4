import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const CliCommandInitEvent = Schema.TaggedStruct("cli-command-init", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandInitEvent = typeof CliCommandInitEvent.Type;

export const CliCommandRunEvent = Schema.TaggedStruct("cli-command-run", {
  commandId: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandRunEvent = typeof CliCommandRunEvent.Type;

export const CliCommandErrorEvent = Schema.TaggedStruct("cli-command-error", {
  commandId: Schema.String,
  message: Schema.String,
  timestamp: Timestamp,
});
export type CliCommandErrorEvent = typeof CliCommandErrorEvent.Type;
