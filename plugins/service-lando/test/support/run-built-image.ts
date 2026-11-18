import { expect } from "bun:test";
import { decodeLogStream } from "@lando/container-runtime/streams";
import { makePodmanApiClient } from "@lando/provider-lando";
import { Effect, Schema, Stream } from "effect";

/** Container name prefix for every create from this helper; force-removed in the finalizer. */
export const BUILT_IMAGE_CONTAINER_PREFIX = "lando-build-test-" as const;

export interface RunBuiltImageOptions {
  readonly user?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Run with no network so a test proves the image already holds what the command needs. */
  readonly offline?: boolean;
  /** Shell script used in place of `command` (for multi-step checks that still keep network none). */
  readonly script?: string;
  /** Override an image-configured user (e.g. root sabotage of image paths). */
  readonly asRoot?: boolean;
  readonly binds?: readonly string[];
}

export const runBuiltImage = async (
  socketPath: string,
  image: string,
  command: readonly string[],
  options: RunBuiltImageOptions = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = makePodmanApiClient(socketPath);
        const request = api.request;
        const stream = api.stream;
        if (request === undefined || stream === undefined)
          throw new TypeError("Container API requests and logs are required");

        const hostConfig: Record<string, unknown> = {};
        if (options.offline === true) hostConfig.NetworkMode = "none";
        if (options.binds !== undefined) hostConfig.Binds = [...options.binds];

        const created = yield* request({
          method: "POST",
          path: `/containers/create?name=${BUILT_IMAGE_CONTAINER_PREFIX}${crypto.randomUUID()}`,
          body: {
            Image: image,
            Cmd: options.script === undefined ? command : ["sh", "-c", options.script],
            ...(options.user === undefined ? {} : { User: options.user }),
            ...(options.asRoot === true ? { User: "0" } : {}),
            ...(Object.keys(hostConfig).length === 0 ? {} : { HostConfig: hostConfig }),
            ...(options.env === undefined
              ? {}
              : { Env: Object.entries(options.env).map(([name, value]) => `${name}=${value}`) }),
          },
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
