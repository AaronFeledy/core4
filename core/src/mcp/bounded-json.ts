import { Effect } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";

import { isRuntimeProxy } from "./runtime-proxy.ts";
import { MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits.ts";

const LIMIT_LABEL = "8 MiB";
const STRING_CHUNK_CODE_UNITS = 1_024;
const SEGMENT_CODE_UNITS = 64 * 1_024;
const identityRedactor: Redactor = {
  redactString: (text) => text,
  redactStringBounded: (text) => text,
  redactValue: (value) => value,
};

const serializationFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} could not be serialized as bounded JSON.`);

const limitFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} exceeded the ${LIMIT_LABEL} JSON serialization limit.`);

const isOmittedObjectValue = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

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
  readonly #ancestors = new WeakSet<object>();
  readonly #segments: string[] = [];
  #pending = "";
  #bytes = 0;
  #inputBytes = 0;

  constructor(redactor: Redactor, context: string) {
    this.#redactor = redactor;
    this.#context = context;
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

  #secretKeyReplacement(key: string): string | undefined {
    const redacted = this.#redactor.redactValue({ [key]: null });
    if (
      redacted === null ||
      typeof redacted !== "object" ||
      Array.isArray(redacted) ||
      isRuntimeProxy(redacted)
    ) {
      throw serializationFailure(this.#context);
    }
    const descriptor = Object.getOwnPropertyDescriptor(redacted, key);
    if (descriptor === undefined || !("value" in descriptor)) throw serializationFailure(this.#context);
    const replacement = descriptor.value;
    if (replacement === null) return undefined;
    if (typeof replacement !== "string") throw serializationFailure(this.#context);
    return replacement;
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

  #writeArray(value: ReadonlyArray<unknown>): void {
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
          this.#writeValue(descriptor.value, false);
        }
      }
      this.#append("]");
    });
  }

  #writeObject(value: object): void {
    if (!isPlainObject(value) || Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) {
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
        const secretKeyReplacement = this.#secretKeyReplacement(key);
        if (secretKeyReplacement === undefined && !("value" in descriptor)) {
          throw serializationFailure(this.#context);
        }
        if (secretKeyReplacement === undefined && isOmittedObjectValue(descriptor.value)) continue;
        if (emitted > 0) this.#append(",");
        this.#appendString(key, true, false);
        this.#append(":");
        if (secretKeyReplacement !== undefined) this.#appendString(secretKeyReplacement, false, false);
        else this.#writeValue(descriptor.value, false);
        emitted += 1;
      }
      this.#append("}");
    });
  }

  #writeValue(value: unknown, root: boolean): void {
    if (value === null) {
      this.#append("null");
      return;
    }
    if (typeof value === "string") {
      this.#appendString(value, true);
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
      this.#writeArray(value);
      return;
    }
    this.#writeObject(value);
  }

  write(value: unknown): string {
    this.#writeValue(value, true);
    if (this.#segments.length === 0) return this.#pending;
    if (this.#pending.length > 0) this.#segments.push(this.#pending);
    return this.#segments.join("");
  }
}

const stringifyWithinLimit = (value: unknown, redactor: Redactor, context: string): string =>
  new BoundedJsonWriter(redactor, context).write(value);

export const stringifyBoundedJson = (
  value: unknown,
  context: string,
  redactor: Redactor = identityRedactor,
): Effect.Effect<string, McpTransportError> =>
  Effect.try({
    try: () => stringifyWithinLimit(value, redactor, context),
    catch: (cause) => (cause instanceof McpTransportError ? cause : serializationFailure(context)),
  });

export const redactBoundedJsonValue = (
  value: unknown,
  redactor: Redactor,
  context: string,
): Effect.Effect<unknown, McpTransportError> =>
  stringifyBoundedJson(value, context, redactor).pipe(
    Effect.flatMap((encoded) =>
      Effect.try({
        try: (): unknown => JSON.parse(encoded),
        catch: () => serializationFailure(context),
      }),
    ),
  );
