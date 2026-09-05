import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { DateTime, Effect, Exit, Schema, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type ImagePullProgressEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";

import { dockerPullDialect, libpodPullDialect, parseImageReference } from "../src/dialect.ts";
import type { PullDialect } from "../src/dialect.ts";
import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import {
  buildImagePullRequest,
  classifyPullFailure,
  parseImagePullFrame,
  pullImage,
} from "../src/image-pull.ts";
import type { PullFailureKind } from "../src/image-pull.ts";
import { makePodmanApiClient } from "../src/podman/api-client.ts";

const dockerCtx = {
  providerId: "docker",
  remediation: "Run `lando doctor --provider=docker` and retry.",
} as const;
const landoCtx = {
  providerId: "lando",
  remediation: "Run `lando doctor` and retry.",
} as const;
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const unsafeText = "s3cr3tPass";
const encodedUnsafeText = encodeURIComponent(unsafeText);

type DialectCase = readonly [name: string, dialect: PullDialect];
const dialects: ReadonlyArray<DialectCase> = [
  ["docker", dockerPullDialect],
  ["libpod", libpodPullDialect],
];

const inspectSuccess = (reference: string): EngineHttpResponse => ({
  status: 200,
  body: JSON.stringify({ RepoDigests: [`${reference}@sha256:test`] }),
});

const withClosingSocket = async <T>(run: (socketPath: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-container-runtime-pull-"));
  const socketPath = join(dir, "podman.sock");
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run(socketPath);
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await rm(dir, { recursive: true, force: true });
  }
};

const runStreamPull = async (
  dialect: PullDialect,
  reference: string,
  chunks: ReadonlyArray<Uint8Array>,
  streamFactory?: (
    input: ReadonlyArray<Uint8Array>,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>,
) => {
  const events: ImagePullProgressEvent[] = [];
  const requests: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    stream: (request) => {
      requests.push(request);
      return streamFactory === undefined ? Stream.fromIterable(chunks) : streamFactory(chunks);
    },
    request: (request) => {
      requests.push(request);
      return Effect.succeed(inspectSuccess(reference));
    },
  };
  const exit = await Effect.runPromiseExit(
    pullImage(api, reference, {
      ctx: dialect === dockerPullDialect ? dockerCtx : landoCtx,
      dialect,
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    }),
  );
  return { events, exit, requests };
};

describe.each(dialects)("%s image pull dialect", (_name, dialect) => {
  test("maps shared status and progressDetail fields to progress", () => {
    // Given
    const line = '{"status":"Downloading","progressDetail":{"current":100,"total":200}}';

    // When
    const frame = parseImagePullFrame(line, dialect);

    // Then
    expect(frame).toEqual({ kind: "progress", stream: "Downloading", current: 100, total: 200 });
  });

  test("publishes redacted progress events from a streaming response", async () => {
    // Given
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";

    // When
    const { events, exit } = await runStreamPull(dialect, reference, [
      bytes(`{"stream":"Trying to pull ${reference}..."}\n`),
      bytes('{"status":"Downloading","progressDetail":{"current":100,"total":200}}\n'),
    ]);

    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event._tag === "image-pull-progress")).toBe(true);
    expect(events.every((event) => event.eventName === "image-pull-progress")).toBe(true);
    expect(events[1]?.current).toBe(100);
    expect(events[1]?.total).toBe(200);
    expect(events.every(Schema.is(LandoEventSchema))).toBe(true);
    expect(events.every((event) => DateTime.isDateTime(event.timestamp))).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("s3cr3tPass");
    expect(serialized).toContain("[redacted]");
  });

  test("reassembles split frames and flushes a trailing frame", async () => {
    // Given
    const chunks = [bytes('{"stream":"Trying to '), bytes('pull..."}\n{"stream":"final frame"}')];

    // When
    const { events, exit } = await runStreamPull(dialect, "alpine:3.20", chunks);

    // Then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events.map((event) => event.stream)).toEqual(["Trying to pull...", "final frame"]);
  });

  test("uses a buffered request fallback when stream is unavailable", async () => {
    // Given
    const reference = "alpine:3.20";
    const calls: EngineHttpRequest[] = [];
    const responses = [
      { status: 200, body: '{"status":"Downloading","progressDetail":{"current":1,"total":2}}\n' },
      inspectSuccess(reference),
    ];
    const api: EngineHttpApi = {
      request: (request) => {
        calls.push(request);
        return Effect.succeed(responses[calls.length - 1] ?? { status: 500, body: "" });
      },
    };
    const events: ImagePullProgressEvent[] = [];

    // When
    const result = await Effect.runPromise(
      pullImage(api, reference, {
        ctx: dialect === dockerPullDialect ? dockerCtx : landoCtx,
        dialect,
        publish: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
    );

    // Then
    expect(result.ref).toBe(reference);
    expect(events).toHaveLength(1);
    expect(calls[0]).toEqual(dialect.request(reference));
  });
});

describe("docker image pull dialect", () => {
  test("builds Docker Engine requests from encoded image and tag values", () => {
    // Given
    const reference = "docker.io/library/alpine:3.20.3";

    // When
    const request = buildImagePullRequest(reference, dockerPullDialect);

    // Then
    expect(request.method).toBe("POST");
    expect(request.path).toContain(`fromImage=${encodeURIComponent("docker.io/library/alpine")}`);
    expect(request.path).toContain(`tag=${encodeURIComponent("3.20.3")}`);
    expect(request.path).not.toContain("/libpod/images/pull");

    const mailpit = buildImagePullRequest("axllent/mailpit:v1.30.1", dockerPullDialect);
    expect(mailpit.path).toContain(`fromImage=${encodeURIComponent("axllent/mailpit")}`);
    expect(mailpit.path).toContain(`tag=${encodeURIComponent("v1.30.1")}`);
    const traefik = buildImagePullRequest("traefik:v3.3", dockerPullDialect);
    expect(traefik.path).toContain("fromImage=traefik");
    expect(traefik.path).toContain("tag=v3.3");
  });

  test("splits tags and digests for Docker Engine requests", () => {
    // Given
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // When / Then
    expect(parseImageReference("nginx")).toEqual({ fromImage: "nginx", tag: "latest" });
    expect(parseImageReference("localhost:5000/team/app")).toEqual({
      fromImage: "localhost:5000/team/app",
      tag: "latest",
    });
    expect(parseImageReference(`nginx:stable@${digest}`)).toEqual({ fromImage: "nginx", tag: digest });
    expect(buildImagePullRequest(`nginx:stable@${digest}`, dockerPullDialect).path).not.toContain(
      encodeURIComponent("nginx:stable"),
    );
  });

  test("extracts errorDetail messages before the Docker error field", () => {
    // Given / When / Then
    expect(
      parseImagePullFrame('{"errorDetail":{"message":"denied"},"error":"fallback"}', dockerPullDialect),
    ).toEqual({ kind: "error", message: "denied" });
    expect(parseImagePullFrame('{"error":"manifest unknown"}', dockerPullDialect)).toEqual({
      kind: "error",
      message: "manifest unknown",
    });
  });

  test("returns the post-pull inspect digest", async () => {
    // Given
    const reference = "alpine:3.20";

    // When
    const { exit, requests } = await runStreamPull(dockerPullDialect, reference, [
      bytes('{"status":"Pull complete"}\n'),
    ]);

    // Then
    expect(exit).toEqual(
      expect.objectContaining({ _tag: "Success", value: { ref: reference, digest: "sha256:test" } }),
    );
    const inspectDialect = dockerPullDialect.inspect;
    if (inspectDialect === undefined) throw new Error("Docker pull dialect must define post-pull inspect");
    expect(requests[1]).toEqual(inspectDialect.request(reference));
  });

  test("fails when post-pull inspect is non-200", async () => {
    // Given
    const api: EngineHttpApi = {
      stream: () => Stream.fromIterable([bytes('{"status":"Pull complete"}\n')]),
      request: () => Effect.succeed({ status: 404, body: '{"message":"No such image"}' }),
    };

    // When
    const failure = await Effect.runPromise(
      pullImage(api, "alpine:3.20", { ctx: dockerCtx, dialect: dockerPullDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.message).toContain("post-pull inspect HTTP 404");
  });

  test("fails with ProviderInternalError when post-pull inspect JSON is malformed", async () => {
    // Given
    const api: EngineHttpApi = {
      stream: () => Stream.empty,
      request: () => Effect.succeed({ status: 200, body: "not-json" }),
    };

    // When
    const failure = await Effect.runPromise(
      pullImage(api, "alpine:3.20", { ctx: dockerCtx, dialect: dockerPullDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
  });
});

describe("libpod image pull dialect", () => {
  test("uses the libpod path and extracts its error field", () => {
    // Given
    const reference = "docker.io/library/alpine:3.20.3";

    // When / Then
    expect(buildImagePullRequest(reference, libpodPullDialect).path).toBe(
      `/libpod/images/pull?reference=${encodeURIComponent(reference)}&pullProgress=true`,
    );
    expect(parseImagePullFrame('{"error":"manifest unknown"}', libpodPullDialect)).toEqual({
      kind: "error",
      message: "manifest unknown",
    });
  });
});

describe.each(dialects)("%s frame parser", (_name, dialect) => {
  test("ignores blank, malformed, and structurally irrelevant frames", () => {
    // Given / When / Then
    expect(parseImagePullFrame("", dialect)).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("   ", dialect)).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame("not-json", dialect)).toEqual({ kind: "ignore" });
    expect(parseImagePullFrame('{"id":"onlyid"}', dialect)).toEqual({ kind: "ignore" });
  });
});

describe("pull failure handling", () => {
  const cases: ReadonlyArray<{ readonly message: string; readonly expected: PullFailureKind }> = [
    { message: "UNAUTHORIZED: access denied", expected: "registry-auth" },
    { message: "authentication required", expected: "registry-auth" },
    { message: "registry request failed with status 401", expected: "registry-auth" },
    { message: "unable to retrieve auth token", expected: "registry-auth" },
    { message: "invalid username/password", expected: "registry-auth" },
    { message: "manifest unknown", expected: "generic" },
    { message: "no such host", expected: "generic" },
    { message: "connection refused", expected: "generic" },
    { message: "", expected: "generic" },
  ];

  for (const { message, expected } of cases) {
    test(`classifies ${JSON.stringify(message)} as ${expected}`, () => {
      expect(classifyPullFailure(message)).toBe(expected);
    });
  }

  test("uses registry-auth remediation and redacts an in-stream failure", async () => {
    // Given
    const reference = "https://user:s3cr3tPass@registry.internal/team/img:1.0";

    // When
    const failure = await Effect.runPromise(
      pullImage(
        { stream: () => Stream.fromIterable([bytes(`{"error":"unauthorized for ${reference}"}\n`)]) },
        reference,
        { ctx: landoCtx, dialect: libpodPullDialect },
      ).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.remediation).toContain("`podman logout --all`");
    expect(failure.remediation).toContain("`docker logout`");
    expect(failure.remediation).toContain("${XDG_RUNTIME_DIR}/containers/auth.json");
    expect(failure.remediation).toContain("$REGISTRY_AUTH_FILE");
    expect(failure.remediation).toContain("$DOCKER_CONFIG");
    expect(failure.remediation).toContain("~/.docker/config.json");
    expect(failure.remediation).toContain("auths");
    expect(failure.details).toMatchObject({ failureKind: "registry-auth" });
    expect(JSON.stringify(failure)).not.toContain("s3cr3tPass");
  });

  test("preserves stream transport failures", async () => {
    // Given
    const transportError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "podman-api",
      message: "Container runtime stream request failed with HTTP 500.",
    });

    // When
    const failure = await Effect.runPromise(
      pullImage({ stream: () => Stream.fail(transportError) }, "alpine:3.20", {
        ctx: landoCtx,
        dialect: libpodPullDialect,
      }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBe(transportError);
  });

  test("redacts credentials from socket transport failures", async () => {
    // Given
    const reference = `https://user:${unsafeText}@registry.internal/team/img:1.0`;

    // When
    const failure = await withClosingSocket((socketPath) =>
      Effect.runPromise(
        pullImage(makePodmanApiClient(socketPath, landoCtx), reference, {
          ctx: landoCtx,
          dialect: libpodPullDialect,
        }).pipe(Effect.flip),
      ),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderInternalError);
    const serialized = JSON.stringify({ message: failure.message, details: failure.details });
    const inspected = inspect({ message: failure.message, details: failure.details });
    for (const text of [serialized, inspected]) {
      expect(text).not.toContain(unsafeText);
      expect(text).not.toContain(encodedUnsafeText);
    }
  });

  test("reports the supplied podman provider context", async () => {
    // Given
    const podmanCtx = { providerId: "podman", remediation: "Repair Podman and retry." } as const;

    // When
    const failure = await Effect.runPromise(
      pullImage(
        { request: () => Effect.succeed({ status: 500, body: '{"message":"failed"}' }) },
        "alpine:3.20",
        { ctx: podmanCtx, dialect: libpodPullDialect },
      ).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.providerId).toBe("podman");
    expect(failure.remediation).toBe(podmanCtx.remediation);
  });

  test("fails through missingApi when neither transport method exists", async () => {
    // Given / When
    const failure = await Effect.runPromise(
      pullImage({}, "alpine:3.20", { ctx: dockerCtx, dialect: dockerPullDialect }).pipe(Effect.flip),
    );

    // Then
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect(failure.providerId).toBe("docker");
  });

  test("emits no output through console or process streams", async () => {
    // Given
    const spies = [
      spyOn(console, "log").mockImplementation(() => undefined),
      spyOn(console, "error").mockImplementation(() => undefined),
      spyOn(console, "warn").mockImplementation(() => undefined),
      spyOn(console, "info").mockImplementation(() => undefined),
      spyOn(process.stdout, "write").mockImplementation(() => true),
      spyOn(process.stderr, "write").mockImplementation(() => true),
    ];

    try {
      // When
      await Effect.runPromise(
        pullImage({ stream: () => Stream.fromIterable([bytes('{"stream":"pulling"}\n')]) }, "alpine:3.20", {
          ctx: landoCtx,
          dialect: libpodPullDialect,
        }),
      );

      // Then
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
