import { expect } from "bun:test";
import { decodeLogStream } from "@lando/container-runtime/streams";
import { makePodmanApiClient } from "@lando/provider-lando";
import { Effect, Schema, Stream } from "effect";

export const runBuiltImage = async (socketPath: string, image: string, command: readonly string[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = makePodmanApiClient(socketPath);
        const request = api.request;
        const stream = api.stream;
        if (request === undefined || stream === undefined)
          throw new TypeError("Container API requests and logs are required");
        const created = yield* request({
          method: "POST",
          path: `/containers/create?name=lando-build-test-${crypto.randomUUID()}`,
          body: { Image: image, Cmd: command },
        });
        expect(created.status, created.body).toBe(201);
        const { Id } = Schema.decodeUnknownSync(Schema.Struct({ Id: Schema.String }))(
          JSON.parse(created.body),
        );
        yield* Effect.addFinalizer(() =>
          request({ method: "DELETE", path: `/containers/${Id}?force=true&v=true` }).pipe(
            Effect.tap((removed) => Effect.sync(() => expect(removed.status, removed.body).toBe(204))),
            Effect.orDie,
          ),
        );
        const started = yield* request({ method: "POST", path: `/containers/${Id}/start` });
        expect(started.status, started.body).toBe(204);
        const waited = yield* request({ method: "POST", path: `/containers/${Id}/wait` });
        expect(waited.status, waited.body).toBe(200);
        const { StatusCode } = Schema.decodeUnknownSync(Schema.Struct({ StatusCode: Schema.Number }))(
          JSON.parse(waited.body),
        );
        const lines = yield* Stream.runCollect(
          decodeLogStream(
            stream({
              method: "GET",
              path: `/containers/${Id}/logs?stdout=true&stderr=true`,
            }),
          ),
        );
        return {
          exitCode: StatusCode,
          stdout: lines
            .filter((line) => line.stream === "stdout")
            .map((line) => line.line)
            .join("\n"),
          stderr: lines
            .filter((line) => line.stream === "stderr")
            .map((line) => line.line)
            .join("\n"),
        };
      }),
    ),
  );
