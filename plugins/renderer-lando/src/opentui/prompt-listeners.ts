import type { EventEmitterLike, EventListenerLike } from "./prompt-driver-types.ts";

/** A control's teardown for any renderer-level listeners it registered while the prompt was live. */
export type PromptDisposer = () => void;

/** No-op disposer for controls that register no renderer-level listeners. */
export const noopDisposer: PromptDisposer = () => {};

/** Remove a previously-registered emitter listener via whichever removal method the emitter exposes. */
export const removeListener = <A extends ReadonlyArray<unknown>>(
  emitter: EventEmitterLike,
  event: string,
  listener: EventListenerLike<A>,
): void => {
  if (emitter.off !== undefined) {
    emitter.off(event, listener);
    return;
  }
  emitter.removeListener?.(event, listener);
};
