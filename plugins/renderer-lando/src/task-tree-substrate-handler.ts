import type { RendererIO } from "@lando/sdk/renderer";
import type { LandoEvent } from "@lando/sdk/services";

import { isRenderableTaskTreeEvent, renderPlainLine } from "./format.ts";
import { TaskTreeAnimationController } from "./task-tree-animation.ts";
import { TaskTreeViewModel } from "./task-tree-tail.ts";

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
  const viewModel = new TaskTreeViewModel({
    getTerminalColumns: () => terminalColumns,
    getTerminalRows: () => terminalRows,
  });
  const renderFooter = (): void => controller.setFooter(viewModel.frameLines());
  const animation = new TaskTreeAnimationController(viewModel, {
    render: renderFooter,
    requestLive: () => controller.requestLive(),
    dropLive: () => controller.dropLive(),
  });
  const consume = (event: LandoEvent): void => {
    if (isRenderableTaskTreeEvent(event)) {
      const expandedTaskId = viewModel.expandedTaskId;
      viewModel.apply(event);
      animation.consume(event);
      if (expandedTaskId !== undefined && viewModel.expandedTaskId === undefined) {
        controller.exitFullTail();
      }
      if (event._tag === "task.tree.complete") {
        for (const line of viewModel.treeFrameLines()) controller.commitScrollback(line);
        if (viewModel.expandedTaskId !== undefined) {
          renderFooter();
          return;
        }
        controller.setFooter([]);
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
  return { viewModel, consume, resize, renderFooter, dispose: () => animation.dispose() };
};
