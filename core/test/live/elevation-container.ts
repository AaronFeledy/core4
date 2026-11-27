/**
 * One run of an elevation test container, driven through the libpod API alone. The image is built
 * from a Containerfile when its content tag is missing, files reach the container through the
 * archive endpoint, and the container is removed whatever happens. Nothing is bind-mounted, so the
 * socket may belong to a Podman on another machine or VM, such as the WSL bridge socket.
 */
import { createHash } from "node:crypto";
import {
  type EngineHttpRequest,
  type EngineHttpResponse,
  buildContainerRemoveRequest,
} from "@lando/container-runtime/engine-api";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { decodeLogStream } from "@lando/container-runtime/streams";
import { encodeUstarHeader, endOfArchive, padToBlock } from "@lando/container-runtime/tar";
import { Effect, Schema, Stream } from "effect";

export interface ContainerFile {
  /** Path inside the container, relative to `/`; parent directories are created 0755. */
  readonly path: string;
  readonly mode: number;
  readonly content: Uint8Array;
}

export interface ElevationContainerRun {
  readonly socketPath: string;
  /** Image name suffix; the tag is the Containerfile's content digest. */
  readonly variant: string;
  readonly containerfile: string;
  readonly files: readonly ContainerFile[];
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

export interface ElevationContainerResult {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const BUILD_TIMEOUT_MS = 15 * 60_000;
const CONTEXT = { providerId: "podman", remediation: "Check the live test Podman socket.", env: {} };
const WaitResponse = Schema.fromJsonString(Schema.Struct({ StatusCode: Schema.Number }));
const BuildFrame = Schema.fromJsonString(Schema.Struct({ error: Schema.optionalKey(Schema.String) }));

const tarArchive = (files: readonly ContainerFile[]): Uint8Array => {
  const directories = [
    ...new Set(
      files.flatMap(({ path }) =>
        path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => `${parts.slice(0, index + 1).join("/")}/`),
      ),
    ),
  ];
  const blocks = [
    ...directories.map((name) => encodeUstarHeader({ name, mode: 0o755, size: 0, typeflag: "5" })),
    ...files.flatMap(({ path, mode, content }) => [
      encodeUstarHeader({ name: path, mode, size: content.byteLength, typeflag: "0" }),
      content,
      new Uint8Array(padToBlock(content.byteLength)),
    ]),
    endOfArchive(),
  ];
  const archive = new Uint8Array(blocks.reduce((size, block) => size + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
};

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

type Call = (input: EngineHttpRequest, expected: readonly number[]) => Promise<EngineHttpResponse>;

/** Tagged with the Containerfile's digest, so an edited Containerfile builds a new image. */
const ensureImage = async (call: Call, variant: string, containerfile: string): Promise<string> => {
  const tag = `localhost/lando-test-elevation-${variant}:${createHash("sha256").update(containerfile).digest("hex").slice(0, 12)}`;
  const image = await call({ method: "GET", path: `/images/${encodeURIComponent(tag)}/json` }, [200, 404]);
  if (image.status === 200) return tag;
  const params = new URLSearchParams({ t: tag, dockerfile: "Containerfile", rm: "true", forcerm: "true" });
  const built = await call(
    {
      method: "POST",
      path: `/build?${params}`,
      headers: { "Content-Type": "application/x-tar" },
      stdin: once(
        tarArchive([
          { path: "Containerfile", mode: 0o644, content: new TextEncoder().encode(containerfile) },
        ]),
      ),
      signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
    },
    [200],
  );
  // The build endpoint reports a failed step inside its 200 response stream.
  const failure = built.body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => Schema.decodeUnknownSync(BuildFrame)(line).error)
    .find((error) => error !== undefined);
  if (failure !== undefined)
    throw new Error(`Building ${tag} failed: ${failure}\n${built.body.slice(-4000)}`);
  return tag;
};

export const runElevationContainer = async (
  run: ElevationContainerRun,
): Promise<ElevationContainerResult> => {
  const { request, stream } = makePodmanApiClient(run.socketPath, CONTEXT);
  if (request === undefined || stream === undefined)
    throw new TypeError("The Podman API client has no transport.");
  const call: Call = async (input, expected) => {
    const response = await Effect.runPromise(request(input));
    if (!expected.includes(response.status)) {
      throw new Error(
        `${input.method} ${input.path} answered HTTP ${response.status}: ${response.body.slice(-4000)}`,
      );
    }
    return response;
  };

  const tag = await ensureImage(call, run.variant, run.containerfile);
  const name = `lando-test-elevation-${run.variant}-${crypto.randomUUID().slice(0, 8)}`;
  await call(
    {
      method: "POST",
      path: `/containers/create?name=${name}`,
      body: { Image: tag, Cmd: run.command, User: "root" },
    },
    [201],
  );
  try {
    await call(
      {
        method: "PUT",
        path: `/containers/${name}/archive?path=/`,
        headers: { "Content-Type": "application/x-tar" },
        stdin: once(tarArchive(run.files)),
      },
      [200],
    );
    await call({ method: "POST", path: `/containers/${name}/start` }, [204]);
    const waited = await call(
      { method: "POST", path: `/containers/${name}/wait`, signal: AbortSignal.timeout(run.timeoutMs) },
      [200],
    );
    const lines = await Effect.runPromise(
      Stream.runCollect(
        decodeLogStream(stream({ method: "GET", path: `/containers/${name}/logs?stdout=true&stderr=true` })),
      ),
    );
    return {
      exitCode: Schema.decodeUnknownSync(WaitResponse)(waited.body).StatusCode,
      stdout: lines.filter((line) => line.stream === "stdout").map(({ line }) => line),
      stderr: lines.filter((line) => line.stream === "stderr").map(({ line }) => line),
    };
  } finally {
    await call(buildContainerRemoveRequest(name), [200, 204, 404]);
  }
};
