import { Context, type Effect } from "effect";

export interface StreamFrameSinkFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

export interface StreamFrameSinkShape {
  readonly emit: (frame: StreamFrameSinkFrame) => Effect.Effect<void>;
}

export class StreamFrameSink extends Context.Tag("@lando/core/StreamFrameSink")<
  StreamFrameSink,
  StreamFrameSinkShape
>() {}
