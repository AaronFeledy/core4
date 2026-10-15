import type { Socket } from "node:net";
import type { Bytes, SocketHttpConnection } from "./transport.ts";

const READ_HIGH_WATER_MARK = 1024 * 1024;

export const socketHttpConnection = (socket: Socket): SocketHttpConnection => {
  const chunks: Bytes[] = [];
  const waiters = new Set<() => void>();
  let queuedBytes = 0;
  let finished = socket.readableEnded || socket.destroyed;
  let failure = socket.errored ?? undefined;
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const onData = (chunk: Bytes) => {
    chunks.push(chunk);
    queuedBytes += chunk.byteLength;
    // Pausing per chunk leaves normal exec output in Readable buffers that destroy-on-error discards.
    if (queuedBytes >= READ_HIGH_WATER_MARK) socket.pause();
    wake();
  };
  const onEnd = () => {
    finished = true;
    wake();
  };
  const onError = (error: Error) => {
    failure ??= error;
    onEnd();
  };
  const cleanup = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.off("error", onError);
    socket.pause();
  };
  // Keep late writer errors handled after the reader removes its listeners.
  socket.on("error", () => undefined);
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onEnd);
  socket.on("error", onError);

  const iterator: AsyncIterator<Bytes> = {
    next: async () => {
      while (chunks.length === 0 && !finished) {
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
      const chunk = chunks.shift();
      if (chunk !== undefined) {
        queuedBytes -= chunk.byteLength;
        if (!finished && queuedBytes <= READ_HIGH_WATER_MARK / 2 && socket.isPaused()) socket.resume();
        return { done: false, value: chunk };
      }
      cleanup();
      if (failure !== undefined) throw failure;
      return { done: true, value: undefined };
    },
    return: async () => {
      finished = true;
      failure = undefined;
      chunks.length = 0;
      queuedBytes = 0;
      cleanup();
      wake();
      return { done: true, value: undefined };
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    write: (data) => {
      if (socket.writable && !socket.destroyed) socket.write(data);
    },
    end: () => {
      if (socket.writable && !socket.destroyed) socket.end();
    },
    destroy: () => {
      socket.destroy();
    },
  };
};
