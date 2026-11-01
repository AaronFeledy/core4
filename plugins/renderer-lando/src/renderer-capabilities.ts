import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_TTY,
  type RendererNarrationIO,
} from "@lando/sdk/renderer";

export const capabilitiesForIO = (io: RendererNarrationIO) =>
  io.isTTY === true
    ? Object.freeze({ ...RENDERER_CAPABILITIES_TTY, color: io.noColor !== true })
    : RENDERER_CAPABILITIES_NONE;
