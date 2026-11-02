import { Context, Effect } from "effect";

interface StreamFrameProvenance {
  readonly _tag: "stdout" | "stderr";
  readonly service?: string;
  readonly source?: string;
}
export type StreamFrameSinkFrame = StreamFrameProvenance &
  (
    | { readonly kind: "bytes"; readonly chunk: string | Uint8Array }
    | { readonly kind: "record"; readonly chunk: string }
  );

export interface StreamFrameSinkShape {
  readonly emit: (frame: StreamFrameSinkFrame) => Effect.Effect<void>;
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
  let finished = false;
  const sink: StreamFrameSinkShape = {
    emit: (frame) =>
      Effect.sync(() => {
        if (finished) throw new Error("Command output is already finished.");
        channels[frame._tag] +=
          typeof frame.chunk === "string"
            ? decoders[frame._tag].decode() + frame.chunk
            : decoders[frame._tag].decode(frame.chunk, { stream: true });
        if (frame.kind === "record") channels[frame._tag] += "\n";
      }),
  };
  const finish = () =>
    Effect.sync(() => {
      if (finished) return;
      finished = true;
      channels.stdout += decoders.stdout.decode();
      channels.stderr += decoders.stderr.decode();
    });
  return { sink, finish, result: () => ({ ...channels }) };
};
