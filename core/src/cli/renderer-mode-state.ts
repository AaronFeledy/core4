import type { RendererMode } from "./renderer-selection.ts";

export let activeRendererMode: RendererMode = "lando";

export const setActiveRendererMode = (mode: RendererMode): void => {
  activeRendererMode = mode;
};
