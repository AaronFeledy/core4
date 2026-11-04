import { types } from "node:util";
import { inspectionFailure } from "./bounded-data-inspector";
import { isRuntimeProxy } from "./runtime-proxy";

interface LiveProgressProvenance {
  readonly _tag: "stdout" | "stderr";
  readonly service?: string;
  readonly source?: string;
}
export type LiveProgressInput = LiveProgressProvenance &
  (
    | { readonly kind: "bytes"; readonly chunk: string | Uint8Array }
    | { readonly kind: "record"; readonly chunk: string }
  );

const ownData = (frame: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(frame, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw inspectionFailure("MCP live progress payload");
  return descriptor.value;
};

export const projectLiveProgressInput = (frame: unknown): LiveProgressInput => {
  if (frame === null || typeof frame !== "object" || isRuntimeProxy(frame))
    throw inspectionFailure("MCP live progress payload");
  const prototype = Object.getPrototypeOf(frame);
  if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(frame, "toJSON"))
    throw inspectionFailure("MCP live progress payload");
  const tag = ownData(frame, "_tag");
  const chunk = ownData(frame, "chunk");
  const service = ownData(frame, "service");
  const source = ownData(frame, "source");
  const kind = ownData(frame, "kind");
  if (
    (tag !== "stdout" && tag !== "stderr") ||
    (typeof chunk !== "string" &&
      (chunk === null || typeof chunk !== "object" || isRuntimeProxy(chunk) || !types.isUint8Array(chunk))) ||
    (service !== undefined && typeof service !== "string") ||
    (source !== undefined && typeof source !== "string") ||
    (kind !== "bytes" && kind !== "record") ||
    (kind === "record" && typeof chunk !== "string")
  )
    throw inspectionFailure("MCP live progress payload");
  const metadata = {
    _tag: tag,
    ...(service === undefined ? {} : { service }),
    ...(source === undefined ? {} : { source }),
  };
  if (kind === "record" && typeof chunk === "string") return { ...metadata, _tag: tag, kind, chunk };
  return { ...metadata, _tag: tag, kind: "bytes", chunk };
};

export const LIVE_PROGRESS_PIECE_BYTES = 65_536;

export function* liveBytePieces(chunk: string | Uint8Array): Generator<Uint8Array> {
  if (typeof chunk === "string") {
    const encoder = new TextEncoder();
    for (let start = 0; start < chunk.length; ) {
      let end = Math.min(start + LIVE_PROGRESS_PIECE_BYTES / 4, chunk.length);
      const last = chunk.charCodeAt(end - 1);
      if (end < chunk.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield encoder.encode(chunk.slice(start, end));
      start = end;
    }
    return;
  }
  // The native iterator reads internal typed-array slots, never supplied properties or species.
  const iterator = Uint8Array.prototype.values.call(chunk);
  let next = iterator.next();
  while (!next.done) {
    const piece = new Uint8Array(LIVE_PROGRESS_PIECE_BYTES);
    let size = 0;
    while (!next.done && size < piece.length) {
      piece[size++] = next.value;
      next = iterator.next();
    }
    yield piece.subarray(0, size);
  }
}
