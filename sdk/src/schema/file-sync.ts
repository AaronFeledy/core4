import { Schema } from "effect";

/** Sync direction and conflict-resolution mode. */
export const FileSyncMode = Schema.Literal(
  "two-way-safe",
  "two-way-resolved",
  "one-way-safe",
  "one-way-replica",
);
export type FileSyncMode = typeof FileSyncMode.Type;
