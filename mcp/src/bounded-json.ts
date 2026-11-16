import type { StructuralRedactionNode } from "@lando/sdk/command-result";
import { McpTransportError } from "@lando/sdk/errors";
import type { Redactor, SecretFieldRedaction } from "@lando/sdk/secrets";
import { isSecretFieldName, redactSecretField } from "@lando/sdk/secrets";
import { Effect } from "effect";

import { isRuntimeProxy } from "./runtime-proxy";
import { MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits";

const LIMIT_LABEL = "8 MiB";
const STRING_CHUNK_CODE_UNITS = 1_024;
const SEGMENT_CODE_UNITS = 64 * 1_024;
const identityRedactor: Redactor = {
  redactString: (text) => text,
  redactPrefix: (text) => text,
  redactStringBounded: (text) => text,
  redactValue: (value) => value,
};

const serializationFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} could not be serialized as bounded JSON.`);

const limitFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} exceeded the ${LIMIT_LABEL} JSON serialization limit.`);

const isOmittedObjectValue = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

const chunkEnd = (value: string, start: number): number => {
  const candidate = Math.min(start + STRING_CHUNK_CODE_UNITS, value.length);
  if (candidate >= value.length) return candidate;
  const finalCodeUnit = value.charCodeAt(candidate - 1);
  const nextCodeUnit = value.charCodeAt(candidate);
  return finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
    ? candidate + 1
    : candidate;
};

class BoundedJsonWriter {
  readonly #encoder = new TextEncoder();
  readonly #redactor: Redactor;
  readonly #context: string;
  readonly #policy: StructuralRedactionNode | undefined;
  readonly #ancestors = new WeakSet<object>();
  readonly #segments: string[] = [];
  #pending = "";
  #bytes = 0;
  #inputBytes = 0;

  constructor(redactor: Redactor, context: string, policy?: StructuralRedactionNode) {
    this.#redactor = redactor;
    this.#context = context;
    this.#policy = policy;
  }

  #append(text: string): void {
    const bytes = this.#encoder.encode(text);
    if (this.#bytes + bytes.byteLength > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(this.#context);
    this.#bytes += bytes.byteLength;
    this.#pending += text;
    if (this.#pending.length >= SEGMENT_CODE_UNITS) {
      this.#segments.push(this.#pending);
      this.#pending = "";
    }
  }

  #assertBoundedInputString(value: string): void {
    for (let start = 0; start < value.length; ) {
      const end = chunkEnd(value, start);
      this.#inputBytes += this.#encoder.encode(value.slice(start, end)).byteLength;
      if (this.#inputBytes > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(this.#context);
      start = end;
    }
  }

  #appendString(value: string, redact: boolean, inspectInput = true): void {
    if (inspectInput) this.#assertBoundedInputString(value);
    const remainingBytes = MAX_OUTBOUND_QUEUED_BYTES - this.#bytes - 2;
    if (remainingBytes < 0) throw limitFailure(this.#context);
    const safeValue = redact ? this.#redactor.redactStringBounded?.(value, remainingBytes) : value;
    if (safeValue === undefined) {
      throw this.#redactor.redactStringBounded === undefined
        ? serializationFailure(this.#context)
        : limitFailure(this.#context);
    }
    this.#append('"');
    for (let start = 0; start < safeValue.length; ) {
      const end = chunkEnd(safeValue, start);
      const encoded = JSON.stringify(safeValue.slice(start, end));
      this.#append(encoded.slice(1, -1));
      start = end;
    }
    this.#append('"');
  }

  #secretDecision(value: unknown, scope: StructuralRedactionNode | undefined): SecretFieldRedaction {
    // Classification must never run a proxy trap, so a proxy is rejected here
    // for object fields and array elements alike.
    if (typeof value === "object" && value !== null && isRuntimeProxy(value))
      throw serializationFailure(this.#context);
    return redactSecretField((text) => this.#redactor.redactString(text), value, scope);
  }

  #writeSecretValue(value: unknown, scope: StructuralRedactionNode | undefined): void {
    this.#writeDecision(this.#secretDecision(value, scope), value, scope);
  }

  #writeDecision(
    decision: SecretFieldRedaction,
    value: unknown,
    scope: StructuralRedactionNode | undefined,
  ): void {
    if (decision.kind === "replace") {
      this.#appendString(decision.text, false, false);
      return;
    }
    if (decision.kind === "ordinary") {
      this.#writeValue(value, false, scope);
      return;
    }
    // The rule keeps structure only for an array or an object whose every key
    // the schema describes, so no other shape can reach this branch.
    if (Array.isArray(value)) {
      this.#writeArray(value, scope, true);
      return;
    }
    if (typeof value === "object" && value !== null) {
      this.#writeObject(value, scope, true);
      return;
    }
    throw serializationFailure(this.#context);
  }

  #withAncestor(value: object, write: () => void): void {
    if (this.#ancestors.has(value)) throw serializationFailure(this.#context);
    this.#ancestors.add(value);
    try {
      write();
    } finally {
      this.#ancestors.delete(value);
    }
  }

  #writeArray(
    value: ReadonlyArray<unknown>,
    scope: StructuralRedactionNode | undefined,
    secret = false,
  ): void {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_OUTBOUND_QUEUED_BYTES ||
      Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined
    ) {
      throw value.length > MAX_OUTBOUND_QUEUED_BYTES
        ? limitFailure(this.#context)
        : serializationFailure(this.#context);
    }
    this.#withAncestor(value, () => {
      this.#append("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) this.#append(",");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          this.#append("null");
        } else if (!("value" in descriptor)) {
          throw serializationFailure(this.#context);
        } else if (isOmittedObjectValue(descriptor.value)) {
          this.#append("null");
        } else {
          const elementScope = scope?.element(index, value.length);
          if (secret) this.#writeSecretValue(descriptor.value, elementScope);
          else this.#writeValue(descriptor.value, false, elementScope);
        }
      }
      this.#append("]");
    });
  }

  #writeObject(value: object, scope: StructuralRedactionNode | undefined, secret = false): void {
    // A runtime proxy is not inspectable output, and its traps must never run
    // during classification.
    if (isRuntimeProxy(value)) throw serializationFailure(this.#context);
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined
    ) {
      throw serializationFailure(this.#context);
    }
    this.#withAncestor(value, () => {
      this.#append("{");
      let emitted = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) throw serializationFailure(this.#context);
        this.#assertBoundedInputString(key);
        if (!("value" in descriptor)) throw serializationFailure(this.#context);
        const fieldValue = descriptor.value;
        const child = scope?.child(key, value);
        const secretField = secret || isSecretFieldName(key);
        const decision = secretField ? this.#secretDecision(fieldValue, child) : undefined;
        // `JSON.stringify` never emits a key whose value it omits, and the rule
        // keeps `undefined` under a secret key.
        const omitted =
          (decision === undefined || decision.kind === "ordinary") && isOmittedObjectValue(fieldValue);
        if (omitted) continue;
        if (emitted > 0) this.#append(",");
        this.#appendString(key, scope?.keyIsDeclared(key, value) !== true, false);
        this.#append(":");
        if (decision !== undefined) this.#writeDecision(decision, fieldValue, child);
        else this.#writeValue(fieldValue, false, child);
        emitted += 1;
      }
      this.#append("}");
    });
  }

  #writeValue(value: unknown, root: boolean, scope: StructuralRedactionNode | undefined): void {
    if (value === null) {
      this.#append("null");
      return;
    }
    if (typeof value === "string") {
      this.#appendString(value, scope?.stringIsExempt(value) !== true);
      return;
    }
    if (typeof value === "number") {
      this.#append(Number.isFinite(value) ? String(value) : "null");
      return;
    }
    if (typeof value === "boolean") {
      this.#append(value ? "true" : "false");
      return;
    }
    if (typeof value === "bigint") throw serializationFailure(this.#context);
    if (isOmittedObjectValue(value)) {
      if (root) throw serializationFailure(this.#context);
      return;
    }
    if (typeof value !== "object") throw serializationFailure(this.#context);
    if (isRuntimeProxy(value)) throw serializationFailure(this.#context);
    if (Array.isArray(value)) {
      this.#writeArray(value, scope);
      return;
    }
    this.#writeObject(value, scope);
  }

  write(value: unknown): string {
    this.#writeValue(value, true, this.#policy);
    if (this.#segments.length === 0) return this.#pending;
    if (this.#pending.length > 0) this.#segments.push(this.#pending);
    return this.#segments.join("");
  }
}

const stringifyWithinLimit = (
  value: unknown,
  redactor: Redactor,
  context: string,
  policy: StructuralRedactionNode | undefined,
): string => new BoundedJsonWriter(redactor, context, policy).write(value);

export const stringifyBoundedJson = (
  value: unknown,
  context: string,
  redactor: Redactor = identityRedactor,
  policy?: StructuralRedactionNode,
): Effect.Effect<string, McpTransportError> =>
  Effect.try({
    try: () => stringifyWithinLimit(value, redactor, context, policy),
    catch: (cause) => (cause instanceof McpTransportError ? cause : serializationFailure(context)),
  });

export const redactBoundedJsonValue = (
  value: unknown,
  redactor: Redactor,
  context: string,
  policy?: StructuralRedactionNode,
): Effect.Effect<import("effect").Schema.Json, McpTransportError> =>
  stringifyBoundedJson(value, context, redactor, policy).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: (): import("effect").Schema.Json => JSON.parse(encoded),
        catch: () => serializationFailure(context),
      }),
    ),
  );
