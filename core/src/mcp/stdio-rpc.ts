import { Effect } from "effect";

import type { McpToolInput } from "./registry.ts";
import type { McpTransportReply } from "./transport.ts";

export type JsonRpcId = string | number | null;
export type ProgressToken = string | number;
export type JsonObject = Readonly<Record<string, unknown>>;

export const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const hasOwn = (value: JsonObject, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const stringField = (value: JsonObject, key: string): string | undefined => {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
};

export const objectField = (value: JsonObject, key: string): JsonObject | undefined => {
  const field = value[key];
  return isJsonObject(field) ? field : undefined;
};

export const jsonRpcIdFrom = (value: unknown): JsonRpcId | undefined => {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  return undefined;
};

export const progressTokenFrom = (value: unknown): ProgressToken | undefined => {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
};

export const idKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

export const parseJsonLine = (line: string): Effect.Effect<unknown, "parse-error"> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(line);
      return parsed;
    },
    catch: () => "parse-error" as const,
  });

export const rpcResult = (id: JsonRpcId, result: unknown): JsonObject => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonObject => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export const errorMessage = (error: McpTransportReply & { readonly ok: false }): string => {
  const data = error.error;
  if (isJsonObject(data)) {
    const tag = stringField(data, "_tag");
    if (typeof tag === "string") return tag;
    const message = stringField(data, "message");
    if (typeof message === "string") return message;
  }
  return "MCP transport error";
};

export const errorData = (error: McpTransportReply & { readonly ok: false }): JsonObject => {
  const data = error.error;
  if (!isJsonObject(data)) return { message: errorMessage(error) };
  const tag = stringField(data, "_tag");
  const message = stringField(data, "message");
  return {
    ...Object.fromEntries(Object.entries(data)),
    ...(typeof tag === "string" ? { _tag: tag } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
};

export const toolInputFrom = (args: JsonObject | undefined): McpToolInput | undefined => {
  if (args === undefined) return undefined;
  const flags = objectField(args, "flags");
  const commandArgs = objectField(args, "args");
  const appPath = stringField(args, "appPath");
  return {
    ...(flags === undefined ? {} : { flags }),
    ...(commandArgs === undefined ? {} : { args: commandArgs }),
    ...(appPath === undefined ? {} : { appPath }),
  };
};
