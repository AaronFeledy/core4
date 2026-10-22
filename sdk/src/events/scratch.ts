import { Schema } from "effect";
import { AppRef } from "../schema/networking.ts";
import { Timestamp } from "./_shared.ts";

// ============================================================================
// Scratch destroy brackets include standard app stop/destroy and local cleanup.
// ============================================================================

const fields = {
  scope: Schema.Literal("scratch").annotate({ description: "Scratch lifecycle scope." }),
  app: Schema.Struct({
    ...AppRef.fields,
    kind: Schema.Literal("scratch").annotate({ description: "Scratch app kind." }),
  }).annotate({
    description:
      "Scratch identity. Without a plan or registry entry, root is the isolated instance directory, never an inferred source owner.",
  }),
  reason: Schema.Literals(["explicit", "scope-close", "poweroff", "gc", "acquire-failure"]).annotate({
    description:
      "Destroy initiator: explicit command, attached scope finalizer, poweroff, GC reap, or failed acquisition rollback.",
  }),
  source: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("fork").annotate({ description: "Forked source app." }) }),
      Schema.Struct({
        kind: Schema.Literal("recipe").annotate({ description: "Recipe source." }),
        ref: Schema.String.annotate({ description: "Recipe reference." }),
      }),
    ]),
  ).annotate({ description: "Recorded acquisition source; omitted when the registry entry is unavailable." }),
  isolate: Schema.optionalKey(Schema.Literals(["full", "baked", "cwd"])).annotate({
    description: "Recorded isolation mode; omitted for unregistered orphans.",
  }),
  shareGlobalStorage: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Recorded global-storage policy; omitted when unavailable rather than inferred.",
  }),
  detached: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Recorded detached lifetime policy; omitted for unregistered orphans.",
  }),
  retainedArtifacts: Schema.Struct({
    volumes: Schema.Boolean.annotate({ description: "Whether keep-volumes retains scratch volumes." }),
    snapshots: Schema.Literals(["none", "kept", "unknown-owner"]).annotate({
      description:
        "none: purge snapshots matching the plan owner and scratch app id; kept: keep-volumes retains snapshots; unknown-owner: no plan is available, so snapshot purge is skipped.",
    }),
  }).annotate({
    description:
      "Intended retention on pre, completed retention on post. Minimal orphan events require only scope, app, reason, retainedArtifacts and timestamp; metadata fields are optional.",
  }),
  timestamp: Timestamp.annotate({
    description: "Time this scratch destroy lifecycle boundary was published.",
  }),
};

export const PreScratchDestroyEvent = Schema.Struct({
  _tag: Schema.tag("pre-scratch-destroy").annotate({
    description: "Scratch destroy opening event discriminator.",
  }),
  ...fields,
});
export type PreScratchDestroyEvent = typeof PreScratchDestroyEvent.Type;

export const PostScratchDestroyEvent = Schema.Struct({
  _tag: Schema.tag("post-scratch-destroy").annotate({
    description:
      "Scratch destroy completion event discriminator; emitted only after registry and root cleanup succeed.",
  }),
  ...fields,
});
export type PostScratchDestroyEvent = typeof PostScratchDestroyEvent.Type;
