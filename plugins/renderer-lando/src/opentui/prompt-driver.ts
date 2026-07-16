import { isDeclinedType, readPromptType } from "./prompt-choice.ts";
import { buildPrompt } from "./prompt-controls.ts";
import type {
  KeyEventLike,
  OpenTuiModuleLike,
  OpenTuiPromptDriverDeps,
  PromptDriverRequestLike,
  RendererLike,
} from "./prompt-driver-types.ts";
import { type PromptDisposer, removeListener } from "./prompt-listeners.ts";

export type {
  OpenTuiModuleLike,
  OpenTuiPromptDriverDeps,
  RendererLike,
} from "./prompt-driver-types.ts";

const opentuiSpecifier = "@opentui/" + "core";

const loadOpenTuiModule = async <R extends RendererLike = RendererLike>(): Promise<OpenTuiModuleLike<R>> => {
  const mod = (await import(opentuiSpecifier)) as OpenTuiModuleLike<R>;
  return mod;
};

const makePromptCancelledError = (): Error => {
  const error = new Error("Prompt cancelled");
  error.name = "PromptCancelledError";
  return error;
};

const isCancellationKey = (key: KeyEventLike): boolean =>
  key.name === "escape" || (key.ctrl === true && key.name === "c") || key.sequence === "\u0003";

export const createOpenTuiPromptDriver = <R extends RendererLike = RendererLike>(
  deps: OpenTuiPromptDriverDeps<R> = {},
): { readRaw: (request: unknown) => Promise<string> } => {
  const loadModule: () => Promise<OpenTuiModuleLike<R>> = deps.loadModule ?? loadOpenTuiModule;
  const startRenderer =
    deps.startRenderer ??
    ((renderer: R): void => {
      renderer.start?.();
    });
  return {
    readRaw: async (request: unknown): Promise<string> => {
      const typedRequest = request as PromptDriverRequestLike;
      const type = readPromptType(typedRequest);
      if (isDeclinedType(type)) throw new Error(`driver declines ${type}`);

      const mod = await loadModule();
      const renderer = await (deps.createRenderer?.(mod) ??
        mod.createCliRenderer({
          stdin: deps.stdin,
          stdout: deps.stdout,
          exitOnCtrlC: false,
          screenMode: "main-screen",
          useMouse: false,
          targetFps: 30,
        }));

      let cancelListener: ((key: KeyEventLike) => void) | undefined;
      let disposePrompt: PromptDisposer | undefined;
      try {
        startRenderer(renderer);
        return await new Promise<string>((resolve, reject) => {
          let settled = false;
          const settle = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            callback();
          };
          const done = (value: string): void => settle(() => resolve(value));
          cancelListener = (key: KeyEventLike): void => {
            if (isCancellationKey(key)) settle(() => reject(makePromptCancelledError()));
          };
          renderer.keyInput.on("keypress", cancelListener);
          disposePrompt = buildPrompt(mod, renderer, typedRequest, done);
          renderer.requestRender?.();
        });
      } finally {
        if (cancelListener !== undefined) removeListener(renderer.keyInput, "keypress", cancelListener);
        disposePrompt?.();
        await renderer.destroy();
      }
    },
  };
};
