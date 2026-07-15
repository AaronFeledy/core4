import { Effect } from "effect";

import { McpTransportError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";

import { MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits.ts";

const LIMIT_LABEL = "8 MiB";

const utf8Bytes = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const quotedJsonBytes = (value: string): number => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes +=
        codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

const isOmittedObjectValue = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

const primitiveJsonBytes = (value: unknown, arrayValue: boolean, rootValue: boolean): number => {
  if (value === null) return 4;
  if (typeof value === "string") return quotedJsonBytes(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "bigint") throw new TypeError("BigInt is not JSON serializable");
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    if (arrayValue) return 4;
    if (rootValue) throw new TypeError("Value is not JSON serializable");
    return 0;
  }
  if (value instanceof String) return quotedJsonBytes(value.valueOf());
  if (value instanceof Number) {
    const number = value.valueOf();
    return Number.isFinite(number) ? String(number).length : 4;
  }
  if (value instanceof Boolean) return value.valueOf() ? 4 : 5;
  return 2;
};

const serializationFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} could not be serialized as bounded JSON.`);

const limitFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} exceeded the ${LIMIT_LABEL} JSON serialization limit.`);

const stringifyWithinLimit = (value: unknown, context: string): string => {
  let retainedBytes = 0;
  let root = true;
  const emittedProperties = new WeakMap<object, number>();
  const reserve = (bytes: number): void => {
    if (retainedBytes + bytes > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(context);
    retainedBytes += bytes;
  };

  const encoded = JSON.stringify(value, function (key, currentValue: unknown): unknown {
    const isRoot = root;
    root = false;
    const holderIsObject = this !== null && typeof this === "object";
    const holderIsArray = Array.isArray(this);

    if (!isRoot) {
      if (holderIsArray) {
        if (key !== "0") reserve(1);
      } else if (!isOmittedObjectValue(currentValue)) {
        if (!holderIsObject) throw serializationFailure(context);
        const emitted = emittedProperties.get(this) ?? 0;
        reserve((emitted === 0 ? 0 : 1) + quotedJsonBytes(key) + 1);
        emittedProperties.set(this, emitted + 1);
      }
    }

    reserve(primitiveJsonBytes(currentValue, holderIsArray, isRoot));
    return currentValue;
  });

  if (encoded === undefined) throw serializationFailure(context);
  if (utf8Bytes(encoded) > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(context);
  return encoded;
};

export const stringifyBoundedJson = (
  value: unknown,
  context: string,
): Effect.Effect<string, McpTransportError> =>
  Effect.try({
    try: () => stringifyWithinLimit(value, context),
    catch: (cause) => (cause instanceof McpTransportError ? cause : serializationFailure(context)),
  });

export const redactBoundedJsonValue = (
  value: unknown,
  redactor: Redactor,
  context: string,
): Effect.Effect<unknown, McpTransportError> =>
  stringifyBoundedJson(value, context).pipe(
    Effect.map((encoded) => redactor.redactString(encoded)),
    Effect.flatMap((redacted) =>
      utf8Bytes(redacted) > MAX_OUTBOUND_QUEUED_BYTES
        ? Effect.fail(limitFailure(context))
        : Effect.try({
            try: () => {
              const parsed: unknown = JSON.parse(redacted);
              return parsed;
            },
            catch: () => serializationFailure(context),
          }),
    ),
  );
