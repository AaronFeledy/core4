import type { PanelView, RendererPanel, RendererPanelContext } from "@lando/sdk/renderer";

const panel: RendererPanel = {
  id: "status-oversize" as RendererPanel["id"],
  render: (_ctx: RendererPanelContext): PanelView => {
    // 9 rows — exceeds PanelView max of 8
    return Array.from({ length: 9 }, (_, i) => [
      {
        text: `row-${i}`,
        tone: "default" as const,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
      },
    ]);
  },
};

export default panel;
