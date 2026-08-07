import type { RendererMode } from "./renderer-selection";

export let activeRendererMode: RendererMode = "lando";

export const setActiveRendererMode = (mode: RendererMode): void => {
  activeRendererMode = mode;
};
