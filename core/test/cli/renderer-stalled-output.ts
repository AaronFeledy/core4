import { Socket } from "node:net";

export const stalledOutput = () => {
  const started = Promise.withResolvers<void>();
  const chunks: string[] = [];
  let blocked = true;
  const stream = Object.assign(new Socket(), {
    write: (chunk: string) => {
      chunks.push(chunk);
      if (blocked) started.resolve();
      return !blocked;
    },
    isTTY: false,
    columns: 80,
    rows: 24,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    getWindowSize: (): [number, number] => [80, 24],
    getColorDepth: () => 1,
    hasColors: () => false,
  });
  return {
    stream,
    chunks,
    started: started.promise,
    release: () => {
      blocked = false;
      stream.emit("drain");
    },
  };
};
