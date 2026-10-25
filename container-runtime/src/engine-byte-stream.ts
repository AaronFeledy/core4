import { Stream } from "effect";
import type { EngineHttpRequest } from "./engine-api.ts";

export const engineByteStream = <E>(
  input: EngineHttpRequest,
  open: (request: EngineHttpRequest) => AsyncGenerator<Uint8Array>,
  onError: (cause: unknown) => E,
): Stream.Stream<Uint8Array, E> =>
  Stream.suspend(() => {
    const controller = new AbortController();
    const iterator = open({
      ...input,
      signal:
        input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]),
    });
    return Stream.fromAsyncIterable(
      {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          return: () => {
            // Async-generator return queues behind next; abort the read before Effect awaits return.
            controller.abort();
            return iterator.return(undefined);
          },
        }),
      },
      onError,
    );
  });
