import type { PanelView, RendererPanel, RendererPanelContext } from "@lando/sdk/renderer";

const panel: RendererPanel = {
  id: "status-delayed" as RendererPanel["id"],
  render: (_ctx: RendererPanelContext): PanelView => {
    const deadline = performance.now() + 25;
    while (performance.now() < deadline) {}
    return [[{ text: "delayed", tone: "success", bold: false, dim: false, italic: false, underline: false }]];
  },
};

export default panel;
