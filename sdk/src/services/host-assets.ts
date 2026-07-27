import { Context, type Effect } from "effect";

export interface LogFileHelperAssetsShape {
  readonly payloads: Effect.Effect<Readonly<Record<string, Uint8Array>>, never>;
}

export class LogFileHelperAssets extends Context.Tag("@lando/core/LogFileHelperAssets")<
  LogFileHelperAssets,
  LogFileHelperAssetsShape
>() {}
