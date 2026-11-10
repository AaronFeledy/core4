import { Option, Schema } from "effect";

export const RUNTIME_SHUTDOWN_KEY = "runtime-shutdown.json";
export const RUNTIME_SHUTDOWN_VERSION = 1;

export const RuntimeShutdownReceipt = Schema.Struct({
  generation: Schema.NonEmptyString,
  bootId: Schema.NonEmptyString,
  state: Schema.Literals(["admitted", "stopped"]),
});
export type RuntimeShutdownReceipt = typeof RuntimeShutdownReceipt.Type;

const ReceiptEnvelope = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(RUNTIME_SHUTDOWN_VERSION), data: RuntimeShutdownReceipt }),
);

export const parseRuntimeShutdownReceipt = (raw: string): RuntimeShutdownReceipt | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ReceiptEnvelope)(raw))?.data;

export const shutdownReceiptProvesIdle = (
  receipt: RuntimeShutdownReceipt | null | undefined,
  bootId: string | undefined,
): boolean =>
  receipt !== undefined &&
  receipt !== null &&
  bootId !== undefined &&
  bootId.length > 0 &&
  (receipt.bootId !== bootId || receipt.state === "stopped");
