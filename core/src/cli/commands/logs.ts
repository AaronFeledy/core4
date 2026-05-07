/**
 * `lando logs` — stream app logs.
 *
 * Supports `--service`, `--follow`, `--tail`, `--since`. Bootstrap level: `app`.
 *
 * Returns a `Stream`. Long-running output (logs, progress, build streams) is
 * `Stream<Chunk, E, R>`; plain async iterators are forbidden in core public API.
 */
import type { Stream } from "effect";

import type { LandoCommandError } from "@lando/sdk/errors";

export interface LogsAppOptions {
  readonly service?: string;
  readonly follow?: boolean;
  readonly tail?: number;
  readonly since?: string;
}

export interface LogChunk {
  readonly service: string;
  readonly timestamp: number;
  readonly level: "stdout" | "stderr";
  readonly content: Uint8Array;
}

export const logsApp = (_options?: LogsAppOptions): Stream.Stream<LogChunk, LandoCommandError, never> => {
  throw new Error("logsApp: not yet implemented");
};
