import { Effect } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

import type { CommandResultOutcome } from "../cli/result-encode.ts";
import { isRuntimeProxy } from "./runtime-proxy.ts";
import { MAX_OUTBOUND_QUEUED_BYTES, stdioTransportError } from "./stdio-limits.ts";

const STRING_CHUNK_CODE_UNITS = 1_024;

const inspectionFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} contains data that cannot be safely inspected before schema encoding.`);

const limitFailure = (context: string): McpTransportError =>
  stdioTransportError(`${context} exceeded the 8 MiB JSON serialization limit before schema encoding.`);

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

const isOmittedValue = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

class BoundedDataInspector {
  readonly #ancestors = new WeakSet<object>();
  readonly #context: string;
  readonly #encoder = new TextEncoder();
  #bytes = 0;

  constructor(context: string) {
    this.#context = context;
  }

  #reserve(bytes: number): void {
    if (this.#bytes + bytes > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(this.#context);
    this.#bytes += bytes;
  }

  #inspectString(value: string): void {
    this.#reserve(2);
    for (let start = 0; start < value.length; ) {
      const end = chunkEnd(value, start);
      const encoded = JSON.stringify(value.slice(start, end));
      this.#reserve(this.#encoder.encode(encoded.slice(1, -1)).byteLength);
      start = end;
    }
  }

  #withAncestor<A>(value: object, inspect: () => A): A {
    if (this.#ancestors.has(value)) throw inspectionFailure(this.#context);
    this.#ancestors.add(value);
    try {
      return inspect();
    } finally {
      this.#ancestors.delete(value);
    }
  }

  #assertSafeContainer(value: object, expectedPrototype: object | null): void {
    if (isRuntimeProxy(value)) throw inspectionFailure(this.#context);
    if (Object.getPrototypeOf(value) !== expectedPrototype) throw inspectionFailure(this.#context);
    if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) {
      throw inspectionFailure(this.#context);
    }
  }

  #inspectArray(value: readonly unknown[]): unknown[] {
    this.#assertSafeContainer(value, Array.prototype);
    if (value.length > MAX_OUTBOUND_QUEUED_BYTES) throw limitFailure(this.#context);
    return this.#withAncestor(value, () => {
      const clone = new Array<unknown>(value.length);
      this.#reserve(2);
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) this.#reserve(1);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          this.#reserve(4);
          continue;
        }
        if (!("value" in descriptor)) throw inspectionFailure(this.#context);
        if (isOmittedValue(descriptor.value)) {
          this.#reserve(4);
          clone[index] = null;
          continue;
        }
        clone[index] = this.#inspectValue(descriptor.value, false);
      }
      return clone;
    });
  }

  #inspectObject(value: object): Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    if (isRuntimeProxy(value)) throw inspectionFailure(this.#context);
    if (prototype !== Object.prototype && prototype !== null) throw inspectionFailure(this.#context);
    if (Object.getOwnPropertyDescriptor(value, "toJSON") !== undefined) {
      throw inspectionFailure(this.#context);
    }
    return this.#withAncestor(value, () => {
      const clone: Record<string, unknown> = Object.create(null);
      this.#reserve(2);
      let emitted = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) throw inspectionFailure(this.#context);
        this.#inspectString(key);
        if (isOmittedValue(descriptor.value)) continue;
        if (emitted > 0) this.#reserve(1);
        this.#reserve(1);
        Object.defineProperty(clone, key, {
          value: this.#inspectValue(descriptor.value, false),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        emitted += 1;
      }
      return clone;
    });
  }

  #inspectValue(value: unknown, root: boolean): unknown {
    if (value === null) {
      this.#reserve(4);
      return null;
    }
    if (typeof value === "string") {
      this.#inspectString(value);
      return value;
    }
    if (typeof value === "number") {
      this.#reserve(Number.isFinite(value) ? String(value).length : 4);
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "boolean") {
      this.#reserve(value ? 4 : 5);
      return value;
    }
    if (typeof value === "bigint") throw inspectionFailure(this.#context);
    if (isOmittedValue(value)) {
      if (root) throw inspectionFailure(this.#context);
      return undefined;
    }
    if (typeof value !== "object") throw inspectionFailure(this.#context);
    if (isRuntimeProxy(value)) throw inspectionFailure(this.#context);
    if (Array.isArray(value)) {
      return this.#inspectArray(value);
    }
    return this.#inspectObject(value);
  }

  inspect(value: unknown): unknown {
    return this.#inspectValue(value, true);
  }
}

const ownString = (value: object, key: string): string | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw inspectionFailure("MCP command failure");
  return typeof descriptor.value === "string" && descriptor.value.length > 0 ? descriptor.value : undefined;
};

const projectFailure = (error: unknown): Record<string, string> => {
  if (error === null || typeof error !== "object") {
    return { _tag: "UnknownError", message: typeof error === "string" ? error : "Command failed." };
  }
  if (isRuntimeProxy(error)) throw inspectionFailure("MCP command failure");
  const tag = ownString(error, "_tag") ?? ownString(error, "name") ?? "UnknownError";
  const message = ownString(error, "message") ?? "Command failed.";
  const remediation = ownString(error, "remediation");
  return remediation === undefined ? { _tag: tag, message } : { _tag: tag, message, remediation };
};

export const inspectMcpCommandOutcome = (
  outcome: CommandResultOutcome,
): Effect.Effect<CommandResultOutcome, McpTransportError> =>
  Effect.try({
    try: () => {
      if (outcome._tag === "success") {
        const value = new BoundedDataInspector("MCP command result").inspect(outcome.value);
        return { _tag: "success", value };
      }
      const error = projectFailure(outcome.error);
      const safeError = new BoundedDataInspector("MCP command failure").inspect(error);
      return { _tag: "failure", error: safeError };
    },
    catch: (cause) => (cause instanceof McpTransportError ? cause : inspectionFailure("MCP command result")),
  });
