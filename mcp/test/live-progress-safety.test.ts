import { describe, expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Exit } from "effect";
import { projectLiveProgressInput } from "../src/live-progress-input";
import { makeStreamFrameSink } from "../src/progress";
import { flushProgress, progressFixture } from "./live-progress-fixture";

describe("MCP live input safety", () => {
  test("rejects frame and chunk hooks without invoking any of them", () => {
    // Given hostile property readers, serializers and proxy traps.
    let hooks = 0;
    const hook = () => {
      hooks++;
      throw new Error("hook invoked");
    };
    const proxy = new Proxy(
      {},
      { get: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook, ownKeys: hook },
    );
    const frames: unknown[] = [
      proxy,
      { _tag: "stdout", chunk: proxy },
      { _tag: "stdout", chunk: new Proxy(new Uint8Array([10]), { get: hook, getPrototypeOf: hook }) },
      { _tag: "stdout", chunk: { toJSON: hook } },
    ];
    for (const key of ["_tag", "chunk", "service", "source", "kind", "toJSON"]) {
      frames.push(Object.defineProperty({ _tag: "stdout", chunk: "safe" }, key, { get: hook }));
    }
    frames.push({ _tag: "stdout", chunk: "safe", toJSON: hook });
    frames.push(Object.create({ _tag: "stdout", chunk: "safe" }));
    // When the live projection sees each untrusted frame.
    for (const frame of frames) expect(() => projectLiveProgressInput(frame)).toThrow();
    // Then rejection never runs user code.
    expect(hooks).toBe(0);
  });

  test("reads branded typed arrays through native slots despite poisoned properties", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given genuine byte arrays with all supplied hooks poisoned.
        const { sink, owner, text } = yield* progressFixture();
        let hooks = 0;
        const hook = () => {
          hooks++;
          throw new Error("hook invoked");
        };
        for (const bytes of [new TextEncoder().encode("typed\n"), Buffer.from("buffer\n")]) {
          for (const key of [
            "buffer",
            "length",
            "byteLength",
            "byteOffset",
            "subarray",
            "slice",
            "values",
            "constructor",
            "toJSON",
            Symbol.iterator,
          ]) {
            Object.defineProperty(bytes, key, { get: hook });
          }
          // When real bytes pass through the sink.
          yield* sink.emit({ _tag: "stdout", chunk: bytes, kind: "bytes" });
        }
        yield* flushProgress(owner);
        // Then no supplied property is touched.
        expect(text()).toBe("typed\nbuffer\n");
        expect(hooks).toBe(0);
      }),
    );
  });

  test("accepts null-prototype frames while rejecting spoofed byte arrays", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given a plain null-prototype frame and a fake typed array.
        const { sink, text } = yield* progressFixture();
        const frame: unknown = Object.create(null, {
          _tag: { value: "stdout" },
          kind: { value: "record" },
          chunk: { value: "safe" },
        });
        // When the sink and input projection consume them.
        yield* sink.emit(projectLiveProgressInput(frame));
        expect(() =>
          projectLiveProgressInput({ _tag: "stdout", chunk: Object.create(Uint8Array.prototype) }),
        ).toThrow();
        // Then safe records are still delivered.
        expect(text()).toBe("safe\n");
      }),
    );
  });

  test("caps channels and metadata without retaining the rejected channel", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Given enough distinct held channels to exhaust the 8 MiB retained budget.
        const { sink, owner, frames } = yield* progressFixture();
        let accepted = 0;
        let rejected = false;
        // When new channel identities arrive.
        for (let index = 0; index < 140; index++) {
          const exit = yield* Effect.exit(
            sink.emit({ _tag: "stdout", chunk: "x", kind: "bytes", source: String(index) }),
          );
          if (Exit.isFailure(exit)) {
            rejected = true;
            break;
          }
          accepted++;
        }
        const oversized = yield* Effect.exit(
          sink.emit({ _tag: "stdout", chunk: "x", kind: "bytes", service: "s".repeat(1_048_577) }),
        );
        yield* flushProgress(owner);
        // Then bounded channels drain once and rejected identities contribute nothing.
        expect(rejected).toBe(true);
        expect(accepted).toBeGreaterThan(0);
        expect(accepted).toBeLessThanOrEqual(128);
        expect(Exit.isFailure(oversized)).toBe(true);
        expect(frames).toHaveLength(accepted);
        const late = yield* Effect.exit(sink.emit({ _tag: "stdout", chunk: "later", kind: "bytes" }));
        expect(Exit.isFailure(late)).toBe(true);
      }),
    );
  });

  test("rejects payload matcher values that cannot fit the retained stream budget", async () => {
    // Given value sets that exceed either the value-only or combined channel budget.
    for (const length of [8_388_608, 8_388_609]) {
      const values = ["s".repeat(length)];
      let notifications = 0;
      const owner = makeStreamFrameSink(
        () =>
          Effect.sync(() => {
            notifications++;
          }),
        createRedactor("secrets", { values: [] }),
        () => values,
      );
      // When a channel would construct an oversized matcher or retain an oversized tail.
      const exit = await Effect.runPromise(
        Effect.exit(owner.sink.emit({ _tag: "stdout", chunk: "s", kind: "bytes" })),
      );
      await Effect.runPromise(flushProgress(owner));
      // Then it fails closed before any output or rejected channel retention.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(notifications).toBe(0);
    }
  });
});
