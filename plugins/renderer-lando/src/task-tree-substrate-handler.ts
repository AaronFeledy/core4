import type { RendererIO } from "@lando/sdk/renderer";
import type { LandoEvent } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeCollection } from "./task-tree-collection.ts";

export interface LiveRegionHandle {
  setFooter(lines: ReadonlyArray<string>): void;
  commitScrollback(text: string): void;
  rememberScrollback(text: string): void;
  requestLive(): void;
  dropLive(): void;
  enterFullTail(): void;
  exitFullTail(): void;
  dispose(): void;
}

export const makeTaskTreeSubstrateHandler = (io: RendererIO, controller: LiveRegionHandle) => {
  let terminalColumns = io.terminalColumns;
  let terminalRows = io.terminalRows;
  const output = {
    render: (): void => controller.setFooter(viewModel.frameLines()),
    requestLive: (): void => controller.requestLive(),
    dropLive: (): void => controller.dropLive(),
  };
  const viewModel = new TaskTreeCollection(
    {
      getTerminalColumns: () => terminalColumns,
      getTerminalRows: () => terminalRows,
    },
    output,
  );
  const renderFooter = output.render;
  const consume = (event: LandoEvent): void => {
    if (isRenderableTaskTreeEvent(event)) {
      const expandedTaskId = viewModel.expandedTaskId;
      const result = viewModel.consume(event);
      if (expandedTaskId !== undefined && viewModel.expandedTaskId === undefined) {
        controller.exitFullTail();
      }
      if (event._tag === "task.tree.complete") {
        for (const line of result.completedLines) controller.commitScrollback(line);
        if (viewModel.expandedTaskId !== undefined) {
          renderFooter();
          return;
        }
        renderFooter();
        return;
      }
      renderFooter();
      return;
    }
    const line = renderPlainLine(event);
    if (line !== null) controller.commitScrollback(line);
  };
  const resize = (width: number, height: number): void => {
    terminalColumns = width;
    terminalRows = height;
    renderFooter();
  };
  return { viewModel, consume, resize, renderFooter, dispose: () => viewModel.dispose() };
};
