import { Schema } from "effect";

import { ManagedFileAction } from "../schema/managed-file.ts";
import { PortablePath } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

// Managed working-tree file lifecycle events. `ManagedFileService` publishes
// one of these for every write/skip/conflict decision. Payloads carry only
// `path`, `owner`, `action`, and a redacted, content-free `summary` — never
// rendered or on-disk file content — so secrets cannot leak via events or
// transcripts.

export const PreManagedFileWriteEvent = Schema.TaggedStruct("pre-managed-file-write", {
  eventName: Schema.Literal("pre-managed-file-write"),
  path: PortablePath,
  owner: Schema.String,
  action: ManagedFileAction,
  /** Redacted, content-free descriptor (action, mode, format, byte length). */
  summary: Schema.String,
  timestamp: Timestamp,
});
export type PreManagedFileWriteEvent = typeof PreManagedFileWriteEvent.Type;

export const PostManagedFileWriteEvent = Schema.TaggedStruct("post-managed-file-write", {
  eventName: Schema.Literal("post-managed-file-write"),
  path: PortablePath,
  owner: Schema.String,
  action: ManagedFileAction,
  /** Redacted, content-free descriptor (action, mode, format, byte length). */
  summary: Schema.String,
  timestamp: Timestamp,
});
export type PostManagedFileWriteEvent = typeof PostManagedFileWriteEvent.Type;

export const ManagedFileConflictDetectedEvent = Schema.TaggedStruct("managed-file-conflict-detected", {
  eventName: Schema.Literal("managed-file-conflict-detected"),
  path: PortablePath,
  owner: Schema.String,
  action: ManagedFileAction,
  /** Redacted, content-free descriptor (conflict resolution, mode, format). */
  summary: Schema.String,
  timestamp: Timestamp,
});
export type ManagedFileConflictDetectedEvent = typeof ManagedFileConflictDetectedEvent.Type;

export const ManagedFileSkippedEvent = Schema.TaggedStruct("managed-file-skipped", {
  eventName: Schema.Literal("managed-file-skipped"),
  path: PortablePath,
  owner: Schema.String,
  action: ManagedFileAction,
  /** Redacted, content-free descriptor (skip reason, mode, format). */
  summary: Schema.String,
  timestamp: Timestamp,
});
export type ManagedFileSkippedEvent = typeof ManagedFileSkippedEvent.Type;
