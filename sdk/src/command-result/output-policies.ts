/**
 * Structural redaction policies for the machine-output documents Lando emits:
 * command result envelopes, result frames, and event frames. Each composes the
 * published wire schema with the schema of what it carries and is compiled once
 * per carried schema.
 */
import { CommandResultEnvelope, StreamFrame } from "@lando/sdk/schema";
import { Schema } from "effect";
import { type StructuralRedactionNode, structuralRedaction } from "./structural-redaction.ts";

/** Compile one policy per carried schema; `Schema.Struct` builds a fresh AST on every call. */
const policyPerSchema = (compose: (schema: Schema.Top) => Schema.Top) => {
  const cache = new WeakMap<object, StructuralRedactionNode>();
  return (schema: Schema.Top): StructuralRedactionNode => {
    let policy = cache.get(schema.ast);
    if (policy === undefined) {
      policy = structuralRedaction(compose(schema));
      cache.set(schema.ast, policy);
    }
    return policy;
  };
};

const envelopeSchema = (resultSchema: Schema.Top) =>
  Schema.Struct({
    ...CommandResultEnvelope.fields,
    result: Schema.optionalKey(resultSchema),
  });

/**
 * The redaction policy for a command result envelope. `result` carries the
 * command's own encoded result schema, so a result literal or declared result
 * key survives even when it equals a registered redaction token. Projected
 * (`--json` dotted) results keep the same schema path and need no separate
 * policy because the policy only constrains present values.
 */
export const commandResultEnvelopePolicy = policyPerSchema(envelopeSchema);

export const resultFramePolicy = policyPerSchema((resultSchema) =>
  Schema.Struct({ _tag: Schema.Literal("result"), envelope: envelopeSchema(resultSchema) }),
);

export const streamFramePolicy: StructuralRedactionNode = structuralRedaction(StreamFrame);

const eventFramePolicies = new Map<string, (payloadSchema: Schema.Top) => StructuralRedactionNode>();

/** An event frame carrying a payload published with `payloadSchema` under the fixed name `event`. */
export const eventFramePolicy = (event: string, payloadSchema: Schema.Top): StructuralRedactionNode => {
  let forEvent = eventFramePolicies.get(event);
  if (forEvent === undefined) {
    forEvent = policyPerSchema((schema) =>
      Schema.Struct({ _tag: Schema.Literal("event"), event: Schema.Literal(event), payload: schema }),
    );
    eventFramePolicies.set(event, forEvent);
  }
  return forEvent(payloadSchema);
};
