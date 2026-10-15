import { Context, type Effect } from "effect";

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
  /** Write leftover held UTF-8 bytes after the last frame. */
  readonly flush?: () => Effect.Effect<void>;
}

export class StreamFrameSink extends Context.Service<StreamFrameSink, StreamFrameSinkShape>()(
  "@lando/core/StreamFrameSink",
) {}
