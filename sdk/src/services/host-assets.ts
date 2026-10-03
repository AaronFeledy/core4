import { Context, type Effect } from "effect";

export class LogFileHelperAssets extends Context.Service<
  LogFileHelperAssets,
  {
    readonly payloads: Effect.Effect<Readonly<Record<string, Uint8Array>>, never>;
  }
>()("@lando/core/LogFileHelperAssets") {}

export type LogFileHelperAssetsShape = LogFileHelperAssets["Service"];
