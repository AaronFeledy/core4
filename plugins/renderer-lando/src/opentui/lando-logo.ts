import type { BoxOptions, OptimizedBuffer, RenderContext } from "@opentui/core";

import { pickLandoLogoWidth, renderLandoLogo } from "../logo.ts";

/**
 * Mount into an already acquired OpenTUI renderer. Injecting its module keeps
 * native imports and terminal acquisition out of this component's import graph.
 */
export const createLandoLogo = (
  module: Pick<typeof import("@opentui/core"), "BoxRenderable" | "Renderable" | "RGBA">,
  context: RenderContext,
  options: BoxOptions = {},
) => {
  class LogoArtwork extends module.Renderable {
    private artwork: ReturnType<typeof renderLandoLogo> | undefined;
    // The existing Lando pink: terminal bright-magenta slot, not a fixed RGB value.
    private readonly foreground = module.RGBA.fromIndex(13);

    protected override renderSelf(buffer: OptimizedBuffer): void {
      const width = pickLandoLogoWidth(this.width, this.height);
      if (width === undefined) {
        this.artwork = undefined;
        return;
      }
      if (this.artwork?.width !== width) this.artwork = renderLandoLogo(width);
      const left = this.x + Math.floor((this.width - this.artwork.width) / 2);
      const top = this.y + Math.floor((this.height - this.artwork.height) / 2);
      for (const [row, line] of this.artwork.lines.entries()) {
        buffer.drawText(line, left, top + row, this.foreground);
      }
    }
  }

  const container = new module.BoxRenderable(context, {
    width: "100%",
    height: "100%",
    shouldFill: false,
    ...options,
  });
  // Yoga gives this child the content box after the parent's padding and borders.
  container.add(
    new LogoArtwork(context, {
      id: `${container.id}-artwork`,
      width: "100%",
      height: "100%",
      minWidth: 0,
      minHeight: 0,
      flexShrink: 1,
    }),
  );
  return container;
};
