import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { socketHttpConnection } from "../src/transport.ts";

test("drains same-tick data before reporting a peer reset", async () => {
  // Given
  const socket = new Socket();
  const connection = socketHttpConnection(socket);
  const iterator = connection[Symbol.asyncIterator]();
  const first = new Uint8Array([1, 2]);
  const second = new Uint8Array([3, 4]);
  const error = Object.assign(new Error("peer reset"), { code: "ECONNRESET" });
  // When
  const pending = iterator.next();
  socket.emit("data", first);
  socket.emit("data", second);
  socket.emit("error", error);
  socket.emit("close");
  // Then
  expect(await pending).toEqual({ done: false, value: first });
  expect(await iterator.next()).toEqual({ done: false, value: second });
  await expect(iterator.next()).rejects.toBe(error);
  connection.destroy();
});

test.each(["end", "close"])("drains queued data before completing on %s", async (event) => {
  // Given
  const socket = new Socket();
  const connection = socketHttpConnection(socket);
  const iterator = connection[Symbol.asyncIterator]();
  const bytes = new Uint8Array([1]);
  // When
  socket.emit("data", bytes);
  socket.emit(event);
  // Then
  expect(await iterator.next()).toEqual({ done: false, value: bytes });
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  connection.destroy();
});

test("return settles pending reads and removes reader listeners", async () => {
  // Given
  const socket = new Socket();
  const initialListeners = new Map(
    ["data", "end", "close"].map((event) => [event, socket.listenerCount(event)]),
  );
  const connection = socketHttpConnection(socket);
  const iterator = connection[Symbol.asyncIterator]();
  // When
  const pending = iterator.next();
  await iterator.return?.();
  // Then
  expect(await pending).toEqual({ done: true, value: undefined });
  for (const [event, count] of initialListeners) expect(socket.listenerCount(event)).toBe(count);
  expect(socket.listenerCount("error")).toBe(1);
  connection.destroy();
});

test("pauses only at the queue high-water mark and resumes after draining", async () => {
  // Given
  const socket = new Socket();
  const connection = socketHttpConnection(socket);
  const iterator = connection[Symbol.asyncIterator]();
  const bytes = new Uint8Array(512 * 1024);
  // When
  socket.emit("data", bytes);
  const belowLimit = socket.isPaused();
  socket.emit("data", bytes);
  const atLimit = socket.isPaused();
  await iterator.next();
  const afterDrain = socket.isPaused();
  await iterator.return?.();
  // Then
  expect(belowLimit).toBe(false);
  expect(atLimit).toBe(true);
  expect(afterDrain).toBe(false);
  connection.destroy();
});
