import { Layer } from "effect";

import type { RendererContribution, RendererIO } from "@lando/sdk/renderer";
import type { EventService } from "@lando/sdk/services";

import type { LiveRegionControllerOptions } from "./opentui/live-region-controller.ts";
import { createLiveRegionController } from "./opentui/live-region-controller.ts";
import { makeLandoService, makeLineModeConsumer } from "./renderer-service.ts";
import { makeTaskTreeConsumerLive } from "./task-tree-consumer-live.ts";
import type { LiveRegionHandle } from "./task-tree-substrate-handler.ts";
import {
  TranscriptTailReader,
  TranscriptTailReaderLive,
  type TranscriptTailReaderShape,
} from "./transcript-tail-reader.ts";

export interface LandoEventConsumerDeps {
  readonly createLiveRegion?: (options: LiveRegionControllerOptions) => Promise<LiveRegionHandle>;
  readonly raiseInterrupt?: () => void;
  readonly transcriptReader?: TranscriptTailReaderShape;
}

export const makeLandoEventConsumer = (
  io: RendererIO,
  deps: LandoEventConsumerDeps = {},
): Layer.Layer<never, never, EventService> => {
  if (io.isTTY !== true) return makeLineModeConsumer(io);
  const stdout = io.externalOutputStream;
  if (stdout === undefined) return makeLineModeConsumer(io);
  const createLiveRegion = deps.createLiveRegion ?? ((options) => createLiveRegionController(options));
  const raiseInterrupt = deps.raiseInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  const readerLayer =
    deps.transcriptReader === undefined
      ? TranscriptTailReaderLive
      : Layer.succeed(TranscriptTailReader, deps.transcriptReader);
  return makeTaskTreeConsumerLive(io, stdout, createLiveRegion, raiseInterrupt).pipe(
    Layer.provide(readerLayer),
  );
};

export const landoRendererContribution: RendererContribution = {
  id: "lando",
  makeService: (io) => makeLandoService(io),
  makeEventConsumer: (io) => makeLandoEventConsumer(io),
};
