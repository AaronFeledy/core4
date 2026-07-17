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

declare const __LANDO_OPENTUI_NATIVE_ROOT__: string;

const publishLoaderProbe = (phase: "attempt" | "ready"): void => {
  const probe = Reflect.get(globalThis, Symbol.for("@lando/test/opentui-loader-probe"));
  if (typeof probe !== "function") return;
  const nativeRoot =
    phase === "ready" && typeof __LANDO_OPENTUI_NATIVE_ROOT__ !== "undefined"
      ? __LANDO_OPENTUI_NATIVE_ROOT__
      : undefined;
  Reflect.apply(probe, undefined, [
    {
      phase,
      specifier: "@opentui/core",
      ...(nativeRoot === undefined ? {} : { nativeRoot }),
    },
  ]);
};

export const loadOpenTuiModule = async (): Promise<OpenTuiModuleLike> => {
  publishLoaderProbe("attempt");
  const mod: unknown = await import("@opentui/core");
  publishLoaderProbe("ready");
  return mod as OpenTuiModuleLike;
};

const makeUnavailableError = (cause?: unknown): Error => {
  const error = new Error("OpenTUI prompt driver is unavailable for this process.", { cause });
  error.name = "OpenTuiPromptUnavailableError";
  return error;
};

const makePromptCancelledError = (): Error => {
  const error = new Error("Prompt cancelled");
  error.name = "PromptCancelledError";
  return error;
};

const isCancellationKey = (key: KeyEventLike): boolean =>
  key.name === "escape" || (key.ctrl === true && key.name === "c") || key.sequence === "\u0003";

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

type OpenTuiPromptDriver = {
  readonly readRaw: (request: unknown, signal?: AbortSignal) => Promise<string>;
};

export function createOpenTuiPromptDriver(): OpenTuiPromptDriver;
export function createOpenTuiPromptDriver<R extends RendererLike>(
  deps: OpenTuiPromptDriverDeps<R>,
): OpenTuiPromptDriver;
export function createOpenTuiPromptDriver(deps: OpenTuiPromptDriverDeps = {}): OpenTuiPromptDriver {
  const loadModule = deps.loadModule ?? loadOpenTuiModule;
  const startRenderer =
    deps.startRenderer ??
    ((renderer: RendererLike): void => {
      renderer.start?.();
    });
  let openTuiAvailable = true;
  let unavailableCause: Error | undefined;
  return {
    readRaw: async (request: unknown, signal?: AbortSignal): Promise<string> => {
      if (isAborted(signal)) throw makePromptCancelledError();
      const typedRequest = request as PromptDriverRequestLike;
      const type = readPromptType(typedRequest);
      if (isDeclinedType(type)) throw new Error(`driver declines ${type}`);
      if (!openTuiAvailable) throw makeUnavailableError(unavailableCause);

      let mod: OpenTuiModuleLike;
      let renderer: RendererLike;
      try {
        mod = await loadModule();
        renderer = await (deps.createRenderer?.(mod) ??
          mod.createCliRenderer({
            stdin: deps.stdin,
            stdout: deps.stdout,
            exitOnCtrlC: false,
            screenMode: "main-screen",
            useMouse: false,
            targetFps: 30,
          }));
      } catch (cause) {
        openTuiAvailable = false;
        throw makeUnavailableError(
          cause instanceof Error
            ? cause
            : new Error("OpenTUI initialization failed with a non-Error cause.", { cause }),
        );
      }

      let cancelListener: ((key: KeyEventLike) => void) | undefined;
      let abortListener: (() => void) | undefined;
      let disposePrompt: PromptDisposer | undefined;
      let promptOutcome:
        | { readonly ok: true; readonly value: string }
        | { readonly ok: false; readonly cause: unknown };
      try {
        if (isAborted(signal)) throw makePromptCancelledError();
        try {
          startRenderer(renderer);
        } catch (cause) {
          openTuiAvailable = false;
          throw makeUnavailableError(
            cause instanceof Error
              ? cause
              : new Error("OpenTUI startup failed with a non-Error cause.", { cause }),
          );
        }
        const value = await new Promise<string>((resolve, reject) => {
          let settled = false;
          const settle = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            callback();
          };
          const done = (value: string): void => settle(() => resolve(value));
          const cancel = (): void => settle(() => reject(makePromptCancelledError()));
          cancelListener = (key: KeyEventLike): void => {
            if (isCancellationKey(key)) cancel();
          };
          if (signal !== undefined) {
            abortListener = cancel;
            signal.addEventListener("abort", abortListener, { once: true });
            if (signal.aborted) {
              cancel();
              return;
            }
          }
          renderer.keyInput.on("keypress", cancelListener);
          disposePrompt = buildPrompt(mod, renderer, typedRequest, done);
          renderer.requestRender?.();
        });
        promptOutcome = { ok: true, value };
      } catch (cause) {
        promptOutcome = {
          ok: false,
          cause:
            cause instanceof Error
              ? cause
              : new Error("OpenTUI prompt failed with a non-Error cause.", { cause }),
        };
      }

      let cleanupCause: unknown;
      try {
        if (cancelListener !== undefined) removeListener(renderer.keyInput, "keypress", cancelListener);
      } catch (cause) {
        cleanupCause = cause;
      }
      try {
        if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
      } catch (cause) {
        cleanupCause ??= cause;
      }
      try {
        disposePrompt?.();
      } catch (cause) {
        cleanupCause ??= cause;
      }
      try {
        await renderer.destroy();
      } catch (cause) {
        cleanupCause ??= cause;
      }
      if (cleanupCause !== undefined) {
        openTuiAvailable = false;
        unavailableCause =
          cleanupCause instanceof Error
            ? cleanupCause
            : new Error("OpenTUI renderer cleanup failed with a non-Error cause.", {
                cause: cleanupCause,
              });
      }
      if (!promptOutcome.ok) throw promptOutcome.cause;
      return promptOutcome.value;
    },
  };
}
