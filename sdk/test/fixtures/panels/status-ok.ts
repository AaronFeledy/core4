import type { PanelView, RendererPanel, RendererPanelContext } from "@lando/sdk/renderer";

const panel: RendererPanel = {
  id: "status-ok" as RendererPanel["id"],
  render: (ctx: RendererPanelContext): PanelView => [
    [
      {
        text: `ok:${ctx.size.columns}x${ctx.size.rows}:${String((ctx.event as { _tag?: string })._tag ?? "")}`,
        tone: "success",
        bold: true,
        dim: false,
        italic: false,
        underline: false,
      },
    ],
  ],
};

export default panel;
