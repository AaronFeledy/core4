import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { VolumeOperationError } from "@lando/sdk/errors";
import { AppId } from "@lando/sdk/schema";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

const stdinBytes = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield bytes(value);
  },
});

const collectAsyncBytes = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  if (input !== undefined) for await (const chunk of input) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe("provider data plane", () => {
  test("imports artifacts from newline-delimited provider load progress", async () => {
    const api: DataPlaneApiClient = {
      request: () =>
        Effect.succeed({
          status: 200,
          body: `${JSON.stringify({ stream: "Loading layer 1/1\n" })}\n${JSON.stringify({ stream: "Loaded image: example/app:latest\n" })}\n`,
        }),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    const ref = await Effect.runPromise(provider.importArtifact(Stream.make(bytes("tar payload"))));

    expect(ref.providerId).toBe("test");
    expect(ref.ref).toBe("example/app:latest");
  });

  test("treats native snapshot wait responses without StatusCode as successful", async () => {
    const paths: string[] = [];
    const api: DataPlaneApiClient = {
      request: (request) => {
        paths.push(request.path);
        if (request.path.includes("/wait")) return Effect.succeed({ status: 200, body: "{}" });
        return Effect.succeed({ status: request.method === "DELETE" ? 204 : 201, body: "{}" });
      },
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      snapshotMode: "native",
      redactDetails: (value) => value,
    });

    const snapshot = await Effect.runPromise(
      Effect.scoped(
        provider.snapshotVolume({ volume: { app: AppId.make("app"), store: "data" }, snapshotId: "snap" }),
      ),
    );

    expect(snapshot.provider).toBe("test");
    expect(snapshot.id).toBe("snap");
    expect(paths.some((path) => path.includes("/commit?"))).toBe(true);
  });

  test("closes ephemeral attach streams after stdin is consumed", async () => {
    let attached = "";
    let attachAborted = false;
    const api: DataPlaneApiClient = {
      request: (request) =>
        Effect.succeed(
          request.path.endsWith("/json")
            ? { status: 200, body: JSON.stringify({ State: { ExitCode: 0 } }) }
            : { status: request.method === "DELETE" ? 204 : 201, body: "{}" },
        ),
      stream: (request) =>
        Stream.fromAsyncIterable(
          (async function* () {
            attached = text(await collectAsyncBytes(request.stdin));
            attachAborted = request.signal?.aborted === true;
            yield new Uint8Array();
          })(),
          (cause) =>
            new VolumeOperationError({
              providerId: "test",
              operation: "run.attach",
              message: "Failed to collect stdin.",
              remediation: "Retry the test.",
              cause,
            }),
        ),
    };
    const provider = makeProviderDataPlane({
      providerId: "test",
      api,
      snapshotMode: "copy",
      redactDetails: (value) => value,
    });

    await Effect.runPromise(
      Effect.scoped(
        provider.run({
          image: "alpine:3.20",
          command: ["cat"],
          stdinStream: stdinBytes("streamed stdin"),
          remove: true,
        }),
      ),
    );

    expect(attached).toBe("streamed stdin");
    expect(attachAborted).toBe(true);
  });
});
