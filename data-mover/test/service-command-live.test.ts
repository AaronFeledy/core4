import { describe, expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { AppId, type DataEndpoint, ServiceName } from "@lando/sdk/schema";
import { type ExecChunk, StreamFrameSink, type StreamFrameSinkFrame } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

import { checkedServiceCommand, serviceCommandStdout } from "../src/service-command-redaction.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (chunk: string | Uint8Array): string =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

const endpoint: Extract<DataEndpoint, { readonly _tag: "serviceCmd" }> = {
  _tag: "serviceCmd",
  app: AppId.make("data-app"),
  service: ServiceName.make("database"),
  command: ["mysqldump", "app"],
};

const dump = (): Stream.Stream<ExecChunk> =>
  Stream.make(
    { kind: "stderr", chunk: bytes("dumping table users\n") },
    { kind: "stdout", chunk: bytes("-- MySQL dump\n") },
    { exitCode: 0 },
  );

const recordingSink = () => {
  const frames: StreamFrameSinkFrame[] = [];
  return {
    frames,
    sink: StreamFrameSink.of({ emit: (frame) => Effect.sync(() => void frames.push(frame)) }),
  };
};

describe("service command live output", () => {
  test("a source command streams its stderr to the invocation sink and keeps stdout as the payload", async () => {
    // Given: an invocation that streams output.
    const { frames, sink } = recordingSink();

    // When: the dump client runs as a transfer source.
    const payload = await Effect.runPromise(
      serviceCommandStdout(dump(), endpoint).pipe(
        Stream.runCollect,
        Effect.provideService(StreamFrameSink, sink),
        Effect.provide(RedactionService.layer),
      ),
    );

    // Then: only the client's diagnostics reached the sink, attributed to its service.
    expect(frames.map((frame) => [frame._tag, frame.service, text(frame.chunk)])).toEqual([
      ["stderr", "database", "dumping table users\n"],
    ]);
    expect(payload.map(text)).toEqual(["-- MySQL dump\n"]);
  });

  test("a target command streams its stderr only when the invocation has a sink", async () => {
    // Given: the same load client with and without a live sink.
    const { frames, sink } = recordingSink();

    // When
    await Effect.runPromise(
      checkedServiceCommand(dump(), endpoint).pipe(
        Effect.provideService(StreamFrameSink, sink),
        Effect.provide(RedactionService.layer),
      ),
    );
    await Effect.runPromise(
      checkedServiceCommand(dump(), endpoint).pipe(Effect.provide(RedactionService.layer)),
    );

    // Then: the streamed run delivered the diagnostics once; the other ran without a sink.
    expect(frames.map((frame) => text(frame.chunk))).toEqual(["dumping table users\n"]);
  });
});
