import { Context, Effect } from "effect";

export interface StreamFrameSinkFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string | Uint8Array;
  readonly service?: string;
  readonly source?: string;
  /** When true, emit the chunk as-is (no extra newline or service prefix). */
  readonly raw?: boolean;
}

export interface StreamFrameSinkShape {
  readonly emit: (frame: StreamFrameSinkFrame) => Effect.Effect<void>;
  /** Finish the logical output stream, including held redaction prefixes. */
  readonly flush?: () => Effect.Effect<void>;
}

export class StreamFrameSink extends Context.Service<StreamFrameSink, StreamFrameSinkShape>()(
  "@lando/core/StreamFrameSink",
) {}

export const createCollectingStreamFrameSink = () => {
  const decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };
  const channels = { stdout: "", stderr: "" };
  const sink: StreamFrameSinkShape = {
    emit: (frame) =>
      Effect.sync(() => {
        channels[frame._tag] +=
          typeof frame.chunk === "string"
            ? decoders[frame._tag].decode() + frame.chunk
            : decoders[frame._tag].decode(frame.chunk, { stream: true });
      }),
    flush: () =>
      Effect.sync(() => {
        channels.stdout += decoders.stdout.decode();
        channels.stderr += decoders.stderr.decode();
      }),
  };
  return { sink, result: () => ({ ...channels }) };
};
