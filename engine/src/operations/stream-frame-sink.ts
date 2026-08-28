import { Context, type Effect } from "effect";

export interface StreamFrameSinkFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
  /** When true, emit the chunk as-is (no extra newline or service prefix). */
  readonly raw?: boolean;
}

export interface StreamFrameSinkShape {
  readonly emit: (frame: StreamFrameSinkFrame) => Effect.Effect<void>;
}

export class StreamFrameSink extends Context.Tag("@lando/core/StreamFrameSink")<
  StreamFrameSink,
  StreamFrameSinkShape
>() {}
