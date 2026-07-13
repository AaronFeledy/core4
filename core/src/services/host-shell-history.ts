import { basename, dirname } from "node:path";
import { Effect, Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";

import { makeStateStore } from "../state/service.ts";

export const DEFAULT_SHELL_HISTORY_LIMIT = 1000;

const stateStore = makeStateStore();
const HistorySchema = Schema.Array(Schema.String);

const historyBucket = (path: string, limit: number) =>
  stateStore.open({
    root: { path: AbsolutePath.make(dirname(path)) },
    key: basename(path),
    schema: HistorySchema,
    version: 1,
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
    default: [],
    codec: {
      encode: (lines) => (lines.length === 0 ? "" : `${lines.join("\n")}\n`),
      decode: (raw) => {
        if (limit <= 0) return [];
        return new TextDecoder()
          .decode(raw)
          .split("\n")
          .filter((line) => line.length > 0)
          .slice(-limit);
      },
    },
  });

export const readShellHistory = async (path: string, limit: number): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    historyBucket(path, limit).pipe(
      Effect.flatMap((bucket) => bucket.get),
      Effect.map((lines) => lines ?? []),
    ),
  );

export const appendShellHistory = async (path: string, line: string, limit: number): Promise<void> => {
  await Effect.runPromise(
    historyBucket(path, limit).pipe(
      Effect.flatMap((bucket) =>
        bucket.update((current) => (limit <= 0 ? [] : [...(current ?? []), line].slice(-limit))),
      ),
    ),
  );
};
