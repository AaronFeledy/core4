import type { EventEmitterLike, EventListenerLike } from "./prompt-driver-types.ts";

export type PromptDisposer = () => void;

export const noopDisposer: PromptDisposer = () => {};

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
