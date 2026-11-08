import { Context } from "effect";
import type { RendererIO } from "./io.ts";

export interface RendererHostContext {
  readonly io: RendererIO;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const RendererHost = Context.Reference<RendererHostContext | undefined>("@lando/renderer/Host", {
  defaultValue: () => undefined,
});
