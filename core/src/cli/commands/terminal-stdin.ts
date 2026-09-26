/**
 * Adapt a flowing terminal stream to cancellable input for remote interactive exec.
 * Readable's built-in async iterator can leave a pending read alive after return().
 */
export const cancellableTerminalStdin = (input: {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]() {
    const chunks: Uint8Array[] = [];
    let waiting:
      | {
          resolve: (result: IteratorResult<Uint8Array>) => void;
          reject: (error: Error) => void;
        }
      | undefined;
    let closed = false;
    let paused = false;
    let failure: Error | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      waiting?.resolve({ done: true, value: undefined });
      waiting = undefined;
      chunks.length = 0;
    };
    const onData = (chunk: Uint8Array) => {
      if (waiting !== undefined) {
        waiting.resolve({ done: false, value: chunk });
        waiting = undefined;
      } else {
        chunks.push(chunk);
        input.pause();
        paused = true;
      }
    };
    const onEnd = () => finish();
    const onError = (error: Error) => {
      failure = error;
      const pending = waiting;
      waiting = undefined;
      finish();
      pending?.reject(error);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    return {
      next: () => {
        const chunk = chunks.shift();
        if (chunk !== undefined) {
          if (paused && chunks.length === 0) {
            paused = false;
            input.resume();
          }
          return Promise.resolve({ done: false as const, value: chunk });
        }
        if (failure !== undefined) return Promise.reject(failure);
        if (closed) return Promise.resolve({ done: true as const, value: undefined });
        if (paused) {
          paused = false;
          input.resume();
        }
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          waiting = { resolve, reject };
        });
      },
      return: () => {
        finish();
        return Promise.resolve({ done: true as const, value: undefined });
      },
    };
  },
});
