import { Context, Effect, Layer } from "effect";

import type { ScratchAppError } from "@lando/sdk/errors";

export interface ScratchResourceScannerService {
  readonly listScratchIds: Effect.Effect<ReadonlyArray<string>, ScratchAppError>;
  readonly pruneScratch: (id: string) => Effect.Effect<void, ScratchAppError>;
}

export class ScratchResourceScanner extends Context.Tag("@lando/core/ScratchResourceScanner")<
  ScratchResourceScanner,
  ScratchResourceScannerService
>() {}

export const ScratchResourceScannerLive = Layer.succeed(ScratchResourceScanner, {
  listScratchIds: Effect.succeed([]),
  pruneScratch: () => Effect.void,
});
