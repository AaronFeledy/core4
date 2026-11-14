import { expect, test } from "bun:test";
import type { BufferSource } from "node:stream/web";
import { DataTransferError, SqlDumpCompressionError } from "@lando/sdk/errors";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { compressDumpStream } from "../src/compression.ts";

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

for (const compression of ["gzip", "zstd"] as const) {
  test(`${compression} preserves an arbitrary tagged provider stream failure`, async () => {
    const failure = new DataTransferError({
      message: "Provider transport refused",
      operation: "exec",
      remediation: "Restart the provider.",
    });
    const source = Stream.concat(Stream.make(new TextEncoder().encode("select 1;")), Stream.fail(failure));
    const error = failureOf(
      await Effect.runPromiseExit(Stream.runDrain(compressDumpStream(source, compression))),
    );
    expect(error).toBe(failure);
  });

  test(`${compression} codec failures with errno-looking codes remain compression errors`, async () => {
    const cause = Object.assign(new Error("native codec failed"), { code: "ENOSPC" });
    const codec = globalThis.CompressionStream;
    globalThis.CompressionStream = class extends codec {
      constructor(...args: ConstructorParameters<typeof codec>) {
        super(...args);
        throw cause;
      }
    };
    try {
      const error = failureOf(
        await Effect.runPromiseExit(
          Stream.runDrain(compressDumpStream(Stream.make(new Uint8Array([1])), compression)),
        ),
      );
      expect(error).toBeInstanceOf(SqlDumpCompressionError);
      expect(error).toMatchObject({ compression, operation: "compress", path: "stdout", cause });
      if (!(error instanceof SqlDumpCompressionError)) throw new Error("expected codec failure");
      expect(error.remediation).not.toMatch(/Free space|quota/u);
    } finally {
      globalThis.CompressionStream = codec;
    }
  });

  test(`${compression} asynchronous codec errors cannot acquire a filesystem role from their code`, async () => {
    const cause = Object.assign(new Error("codec failure"), { code: "EACCES" });
    const codec = globalThis.CompressionStream;
    globalThis.CompressionStream = class extends TransformStream<BufferSource, Uint8Array<ArrayBuffer>> {
      constructor() {
        super({
          transform() {
            throw cause;
          },
        });
      }
    };
    try {
      const error = failureOf(
        await Effect.runPromiseExit(
          Stream.runDrain(compressDumpStream(Stream.make(new Uint8Array([1])), compression)),
        ),
      );
      expect(error).toBeInstanceOf(SqlDumpCompressionError);
      expect(error).toMatchObject({ compression, operation: "compress", cause });
    } finally {
      globalThis.CompressionStream = codec;
    }
  });
}
