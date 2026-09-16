import { pickLandoLogoWidth, renderLandoLogo } from "../logo.ts";
import type {
  LandoLogoBoxOptionsLike,
  LandoLogoModuleLike,
  LandoLogoRenderableLike,
} from "./lando-logo-types.ts";

/**
 * Mount into an already acquired OpenTUI renderer. Injecting its module keeps
 * native imports and terminal acquisition out of this component's import graph.
 */
export const createLandoLogo = <Ctx>(
  module: LandoLogoModuleLike<Ctx>,
  context: Ctx,
  options: LandoLogoBoxOptionsLike = {},
): LandoLogoRenderableLike => {
  let artwork: ReturnType<typeof renderLandoLogo> | undefined;
  // The existing Lando pink: terminal bright-magenta slot, not a fixed RGB value.
  const foreground = module.RGBA.fromIndex(13);

  const container = new module.BoxRenderable(context, {
    width: "100%",
    height: "100%",
    shouldFill: false,
    ...options,
  });
  // Yoga gives this child the content box after the parent's padding and borders.
  // It paints through OpenTUI's public `renderAfter` hook; the box itself draws nothing.
  container.add(
    new module.BoxRenderable(context, {
      id: `${container.id}-artwork`,
      width: "100%",
      height: "100%",
      minWidth: 0,
      minHeight: 0,
      flexShrink: 1,
      shouldFill: false,
      renderAfter(buffer) {
        const width = pickLandoLogoWidth(this.width, this.height);
        if (width === undefined) {
          artwork = undefined;
          return;
        }
        if (artwork?.width !== width) artwork = renderLandoLogo(width);
        const left = this.x + Math.floor((this.width - artwork.width) / 2);
        const top = this.y + Math.floor((this.height - artwork.height) / 2);
        for (const [row, line] of artwork.lines.entries()) {
          buffer.drawText(line, left, top + row, foreground);
        }
      },
    }),
  );
  return container;
};
