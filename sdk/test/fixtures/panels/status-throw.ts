import type { PanelView, RendererPanel, RendererPanelContext } from "@lando/sdk/renderer";

const panel: RendererPanel = {
  id: "status-throw" as RendererPanel["id"],
  render: (_ctx: RendererPanelContext): PanelView => {
    throw new Error("intentional panel throw");
  },
};

export default panel;
