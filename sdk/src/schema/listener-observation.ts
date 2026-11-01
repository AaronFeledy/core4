import { Schema } from "effect";

// ============================================================================
// Failure-time TCP bindings observed in a service's network namespace.
// ============================================================================

export const ListenerObservation = Schema.Struct({
  service: Schema.String.annotate({ description: "Service whose network namespace was observed." }),
  port: Schema.Number.annotate({ description: "Expected TCP listener port." }),
  transport: Schema.Literal("tcp").annotate({ description: "Observed transport." }),
  basis: Schema.Literals(["probe-target", "primary-endpoint"]).annotate({
    description: "Planned listener used to select the expected port.",
  }),
  state: Schema.Literals(["not-listening", "loopback-only", "listening"]).annotate({
    description: "Whether the expected port has no, only loopback, or other TCP bindings.",
  }),
  listening: Schema.Array(
    Schema.Struct({
      address: Schema.String.annotate({
        description: "Observed local binding address, not process ownership.",
      }),
      port: Schema.Number.annotate({ description: "Observed local TCP port." }),
    }),
  ).annotate({ description: "Bounded distinct LISTEN bindings in the shared network namespace." }),
}).annotate({
  identifier: "ListenerObservation",
  description:
    "Failure-time TCP bindings observed in a service's network namespace, selected against the expected listener port.",
});
export type ListenerObservation = typeof ListenerObservation.Type;
