import { Schema } from "effect";

// ============================================================================
// Provider evidence and user-facing storage lifetime facts.
// ============================================================================

export const ObservedMount = Schema.Struct({
  type: Schema.Literals(["bind", "volume", "tmpfs", "unknown"]).annotate({
    description: "Runtime mount kind, without inferring volume ownership from its name.",
  }),
  target: Schema.String.annotate({ description: "Mount destination inside the container." }),
  source: Schema.optionalKey(Schema.String).annotate({
    description: "Host source path or runtime volume name, when known.",
  }),
  readOnly: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether the mount is read-only, when the runtime reports it.",
  }),
});
export type ObservedMount = typeof ObservedMount.Type;

export const MountObservation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("present").annotate({ description: "The container mount table was observed." }),
    mounts: Schema.Array(ObservedMount).annotate({
      description: "Observed mounts, including provider integration mounts.",
    }),
  }),
  Schema.Struct({ status: Schema.Literal("missing").annotate({ description: "The container is absent." }) }),
  Schema.Struct({
    status: Schema.Literal("unknown").annotate({
      description: "Mount evidence is unavailable or malformed.",
    }),
  }),
]);
export type MountObservation = typeof MountObservation.Type;

export const ServiceInfoMount = Schema.Struct({
  ...ObservedMount.fields,
  origin: Schema.Literals(["planned", "runtime"]).annotate({
    description: "Whether this mount matches the resolved service plan or is runtime-only.",
  }),
  observation: Schema.Literals(["present", "missing", "unknown"]).annotate({
    description: "Whether compatible runtime evidence confirms the mount.",
  }),
  lifetime: Schema.Literals(["retained", "container", "unknown"]).annotate({
    description:
      "Retained host or declared store data, container-lifetime temporary memory, or unverified lifetime. Runtime volume names do not prove lifetime.",
  }),
  provenance: Schema.optionalKey(Schema.Literals(["authored", "service", "derived"])).annotate({
    description:
      "For planned mounts: declared in the Landofile, added by the service type, or derived by Lando (exclude shadows, nested includes, Git, home).",
  }),
});
export type ServiceInfoMount = typeof ServiceInfoMount.Type;
