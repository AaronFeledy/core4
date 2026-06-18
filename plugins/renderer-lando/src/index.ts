import { Layer, Schema } from "effect";

import type {
  RendererContribution,
  RendererContributionFactory,
  RendererIO,
  RendererRuntimePrimitives,
} from "@lando/sdk/renderer";
import { PluginManifest } from "@lando/sdk/schema";
import type { EventService } from "@lando/sdk/services";

export const PLUGIN_NAME = "@lando/renderer-lando" as const;

export const renderer = Layer.empty;

const makeLandoEventConsumer = (
  primitives: RendererRuntimePrimitives,
  io: RendererIO,
): Layer.Layer<never, never, EventService> => {
  if (io.isTTY !== true) {
    return primitives.makeEventConsumer((event) => {
      const line = primitives.renderPlainLine(event);
      if (line !== null) io.writeStdout(`${line}\n`);
    });
  }
  const painter = primitives.createTaskTreePainter({
    getTerminalColumns: () => io.terminalColumns,
    getTerminalRows: () => io.terminalRows,
  });
  const display = primitives.makeEventConsumer((event) => {
    if (primitives.isRenderableTaskTreeEvent(event)) {
      io.writeStdout(painter.consume(event));
      return;
    }
    const line = primitives.renderPlainLine(event);
    if (line !== null) io.writeStdout(painter.passthrough(line));
  });
  return io.subscribeInput === undefined ? display : Layer.merge(display, painter.makeInputLive(io));
};

const landoRendererFactory: RendererContributionFactory = {
  id: "lando",
  make: (primitives): RendererContribution => ({
    id: "lando",
    makeService: (io) => primitives.makeRendererService(io, "lando"),
    makeEventConsumer: (io) => makeLandoEventConsumer(primitives, io),
  }),
};

export const rendererFactories: ReadonlyMap<string, RendererContributionFactory> = new Map([
  ["lando", landoRendererFactory],
]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "Bundled default Lando Renderer plugin.",
  enabled: true,
  contributes: { renderers: ["lando"] },
  entry: "./src/index.ts",
});
