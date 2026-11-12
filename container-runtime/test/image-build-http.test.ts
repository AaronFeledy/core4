import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";
import { requestContainerBuild } from "../src/image-build-http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jsonFrame = (value: unknown): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

const transportFailure = (cause: unknown): ProviderUnavailableError | ProviderInternalError =>
  cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
    ? cause
    : new ProviderUnavailableError({
        providerId: "podman",
        operation: "buildArtifact",
        message: "Container runtime stream failed.",
        remediation: "test",
      });

const streamedApi = (chunks: ReadonlyArray<Uint8Array>, failure?: ProviderUnavailableError) => () =>
  Stream.fromAsyncIterable(
    (async function* () {
      for (const chunk of chunks) yield chunk;
      if (failure !== undefined) throw failure;
    })(),
    transportFailure,
  );

type RunBuildInput = {
  readonly stream?: () => Stream.Stream<Uint8Array, ProviderUnavailableError | ProviderInternalError>;
  readonly requestBody?: string;
  readonly requestStatus?: number;
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  readonly onOutput?: (text: string) => Effect.Effect<void, ProviderInternalError>;
};

const runBuild = (input: RunBuildInput) => {
  const request = (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
    Effect.succeed({
      status: request.method === "POST" ? (input.requestStatus ?? 200) : 200,
      body: request.method === "POST" ? (input.requestBody ?? "") : "{}",
    });
  return requestContainerBuild({
    request,
    ...(input.stream === undefined ? {} : { stream: input.stream }),
    options: {
      providerId: "podman",
      api: { request, ...(input.stream === undefined ? {} : { stream: input.stream }) },
      sourceEnv: input.sourceEnv ?? {},
    },
    path: "/build",
    tag: "lando-web",
    stdin: (async function* () {})(),
    secretValues: [],
    ...(input.onOutput === undefined ? {} : { onOutput: input.onOutput }),
  });
};

const providerId = ProviderId.make("docker");
const appId = AppId.make("build-http-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-12T00:00:00Z"),
  source: "container-runtime/image-build-http.test.ts",
  runtime: 4 as const,
};

const plan = (servicePlan: ServicePlan): AppPlan => ({
  id: appId,
  name: "Build HTTP App",
  slug: "build-http-app",
  root: AbsolutePath.make("/tmp/build-http-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

test("returns the first digest when build output mixes malformed lines and JSON frames", () => {
  // Given
  const request = () =>
    Effect.succeed({
      status: 200,
      body: 'invalid\n \n{"aux":{"Digest":"sha256:first"}}\n{"aux":{"Digest":"sha256:second"}}\n',
    });
  // When
  const digest = Effect.runSync(
    requestContainerBuild({
      request,
      options: { providerId: "docker", api: { request }, sourceEnv: {} },
      path: "/build",
      tag: "test-image",
      stdin: (async function* () {})(),
      secretValues: [],
    }),
  );
  // Then
  expect(digest).toBe("sha256:first");
});

test("returns the first build error when invalid lines precede multiple error frames", () => {
  // Given
  const request = () =>
    Effect.succeed({
      status: 200,
      body: 'invalid\n{"errorDetail":{"message":"first failure"}}\n{"error":"second failure"}\n',
    });
  // When
  const error = Effect.runSync(
    requestContainerBuild({
      request,
      options: { providerId: "docker", api: { request }, sourceEnv: {} },
      path: "/build",
      tag: "test-image",
      stdin: (async function* () {})(),
      secretValues: [],
    }).pipe(Effect.flip),
  );
  // Then
  expect(error).toMatchObject({
    _tag: "ArtifactBuildError",
    details: { message: "first failure", tag: "test-image" },
  });
});

test("delivers streamed build output in order before the response ends", async () => {
  // Given
  const outputs: string[] = [];
  const firstOutput = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stream = () =>
    Stream.fromAsyncIterable(
      (async function* () {
        yield jsonFrame({ stream: "STEP 1/2: FROM alpine:3.20\n" });
        await release.promise;
        yield jsonFrame({ stream: "Successfully tagged lando-web\n" });
      })(),
      transportFailure,
    );

  // When
  const running = Effect.runPromise(
    runBuild({
      stream,
      onOutput: (text) =>
        Effect.sync(() => {
          outputs.push(text);
          if (outputs.length === 1) firstOutput.resolve();
        }),
    }),
  );
  await firstOutput.promise;

  // Then
  expect(outputs).toEqual(["STEP 1/2: FROM alpine:3.20\n"]);
  release.resolve();
  await running;
  expect(outputs).toEqual(["STEP 1/2: FROM alpine:3.20\n", "Successfully tagged lando-web\n"]);
});

test("buffers an NDJSON line split across response chunks", async () => {
  // Given
  const outputs: string[] = [];
  const frame = jsonFrame({ stream: "hello\n" });

  // When
  await Effect.runPromise(
    runBuild({
      stream: streamedApi([frame.slice(0, 10), frame.slice(10)]),
      onOutput: (text) =>
        Effect.sync(() => {
          outputs.push(text);
        }),
    }),
  );

  // Then
  expect(outputs).toEqual(["hello\n"]);
});

test("decodes a multi-byte character split across response chunks", async () => {
  // Given
  const outputs: string[] = [];
  const frame = jsonFrame({ stream: "héllo\n" });
  const split = frame.indexOf(0xc3) + 1;

  // When
  await Effect.runPromise(
    runBuild({
      stream: streamedApi([frame.slice(0, split), frame.slice(split)]),
      onOutput: (text) =>
        Effect.sync(() => {
          outputs.push(text);
        }),
    }),
  );

  // Then
  expect(outputs).toEqual(["héllo\n"]);
});

test("projects Docker status frames and skips download ticks", async () => {
  // Given
  const outputs: string[] = [];

  // When
  await Effect.runPromise(
    runBuild({
      stream: streamedApi([
        jsonFrame({ status: "Pulling fs layer", id: "abc" }),
        jsonFrame({ status: "Downloading" }),
        jsonFrame({ status: "Downloading", progressDetail: { current: 5, total: 10 } }),
        jsonFrame({ status: "Extracting", progressDetail: {} }),
      ]),
      onOutput: (text) =>
        Effect.sync(() => {
          outputs.push(text);
        }),
    }),
  );

  // Then
  expect(outputs).toEqual(["abc: Pulling fs layer\n", "Downloading\n", "Extracting\n"]);
});

test("delivers output before an error frame fails the build", async () => {
  // Given
  const outputs: string[] = [];

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      runBuild({
        stream: streamedApi([
          jsonFrame({ stream: "build-step-output-marker\n" }),
          jsonFrame({ errorDetail: { message: "exit status 1" }, error: "exit status 1" }),
        ]),
        onOutput: (text) =>
          Effect.sync(() => {
            outputs.push(text);
          }),
      }),
    ),
  );

  // Then
  expect(failure._tag).toBe("ArtifactBuildError");
  expect(failure.details).toEqual(expect.objectContaining({ message: "exit status 1", tag: "lando-web" }));
  expect(outputs).toEqual(["build-step-output-marker\n"]);
});

test("keeps a remembered build error when reading the response then fails", async () => {
  // Given
  const failure = new ProviderUnavailableError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "Container runtime stream read failed.",
    remediation: "test",
  });

  // When
  const buildFailure = await Effect.runPromise(
    Effect.flip(runBuild({ stream: streamedApi([jsonFrame({ error: "build failed" })], failure) })),
  );

  // Then
  expect(buildFailure._tag).toBe("ArtifactBuildError");
  expect(buildFailure.details).toEqual(expect.objectContaining({ message: "build failed" }));
});

test("appends a JSON reason to a streamed non-2xx build failure", async () => {
  // Given
  const failure = new ProviderUnavailableError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "Container runtime stream request failed with HTTP 400.",
    details: {
      method: "POST",
      path: "/build",
      status: 400,
      body: JSON.stringify({ message: "dockerfile parse error" }),
    },
    remediation: "test",
  });

  // When
  const buildFailure = await Effect.runPromise(Effect.flip(runBuild({ stream: streamedApi([], failure) })));

  // Then
  expect(buildFailure._tag).toBe("ProviderUnavailableError");
  expect(buildFailure.operation).toBe("buildArtifact");
  expect(buildFailure.details).toEqual({ status: 400 });
  expect(buildFailure.message).toContain("Container image build failed with HTTP 400.");
  expect(buildFailure.message).toContain("dockerfile parse error");
});

test("appends trimmed text to a streamed non-2xx build failure", async () => {
  // Given
  const failure = new ProviderUnavailableError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "Container runtime stream request failed with HTTP 500.",
    details: { status: 500, body: "  daemon said no  " },
    remediation: "test",
  });

  // When
  const buildFailure = await Effect.runPromise(Effect.flip(runBuild({ stream: streamedApi([], failure) })));

  // Then
  expect(buildFailure._tag).toBe("ProviderUnavailableError");
  expect(buildFailure.details).toEqual({ status: 500 });
  expect(buildFailure.message).toEndWith("HTTP 500. daemon said no");
});

test("appends a JSON reason to a buffered non-2xx build failure", async () => {
  // When
  const buildFailure = await Effect.runPromise(
    Effect.flip(
      runBuild({
        requestStatus: 400,
        requestBody: JSON.stringify({ message: "dockerfile parse error" }),
      }),
    ),
  );

  // Then
  expect(buildFailure._tag).toBe("ProviderUnavailableError");
  expect(buildFailure.details).toEqual({ status: 400 });
  expect(buildFailure.message).toContain("Container image build failed with HTTP 400.");
  expect(buildFailure.message).toContain("dockerfile parse error");
});

test("fails with the sink error and stops reading further frames", async () => {
  // Given
  let pulls = 0;
  const sinkError = new ProviderInternalError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "sink down",
    remediation: "test",
  });
  const stream = () =>
    Stream.fromAsyncIterable(
      (async function* () {
        pulls += 1;
        yield jsonFrame({ stream: "first\n" });
        pulls += 1;
        yield jsonFrame({ stream: "second\n" });
      })(),
      transportFailure,
    );

  // When
  const failure = await Effect.runPromise(
    Effect.flip(runBuild({ stream, onOutput: () => Effect.fail(sinkError) })),
  );

  // Then
  expect(failure).toBe(sinkError);
  expect(pulls).toBe(1);
});

test("delivers identical output through the buffered fallback", async () => {
  // Given
  const frames = [
    jsonFrame({ stream: "STEP 1/2\n" }),
    jsonFrame({ status: "Pulling fs layer", id: "abc" }),
    jsonFrame({ status: "Downloading", progressDetail: { current: 1, total: 2 } }),
    jsonFrame({ aux: { Digest: "sha256:digest" } }),
  ];
  const streamed: string[] = [];
  const buffered: string[] = [];

  // When
  const streamedDigest = await Effect.runPromise(
    runBuild({
      stream: streamedApi(frames),
      onOutput: (text) =>
        Effect.sync(() => {
          streamed.push(text);
        }),
    }),
  );
  const bufferedDigest = await Effect.runPromise(
    runBuild({
      requestBody: frames.map((frame) => decoder.decode(frame)).join(""),
      onOutput: (text) =>
        Effect.sync(() => {
          buffered.push(text);
        }),
    }),
  );

  // Then
  expect(streamed).toEqual(["STEP 1/2\n", "abc: Pulling fs layer\n"]);
  expect(buffered).toEqual(streamed);
  expect(bufferedDigest).toBe("sha256:digest");
  expect(streamedDigest).toBe("sha256:digest");
});

test("delivers output from every daemon build of an artifact in order", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-build-http-"));
  try {
    await writeFile(join(context, "Dockerfile"), "FROM alpine:3.20\n");
    const outputs: string[] = [];
    const posted: string[] = [];
    const servicePlan: ServicePlan = {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      artifact: {
        kind: "build",
        context: AbsolutePath.make(context),
        spec: PortablePath.make("Dockerfile"),
      },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [{ id: "step", phase: "build", command: "echo hi" }],
        },
      },
    };
    const request = (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
      Effect.succeed({ status: 200, body: request.method === "GET" ? "{}" : "" });
    const stream = (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) => {
      posted.push(request.path);
      return Stream.make(jsonFrame({ stream: request.path.includes("-base") ? "base\n" : "derived\n" }));
    };

    // When
    await Effect.runPromise(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(servicePlan),
          buildKey: "two-builds",
          onOutput: (text) =>
            Effect.sync(() => {
              outputs.push(text);
            }),
        },
        { providerId, api: { request, stream }, sourceEnv: {} },
      ),
    );

    // Then
    expect(posted).toHaveLength(2);
    expect(outputs).toEqual(["base\n", "derived\n"]);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("keeps the source-image naming build out of the forwarded output", async () => {
  // Given: a referenced image whose steps need its inherited user, so a FROM-only build names it first.
  const outputs: string[] = [];
  const posted: string[] = [];
  const servicePlan: ServicePlan = {
    name: serviceName,
    type: "node",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "alpine:3.20" },
    user: "node",
    environment: {},
    mounts: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [{ id: "step", phase: "build", command: "echo hi" }],
      },
    },
  };
  const request = (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) =>
    Effect.succeed({ status: 200, body: request.method === "GET" ? '{"Config":{"User":""}}' : "" });
  const stream = (request: { readonly method: "GET" | "POST"; readonly path: `/${string}` }) => {
    posted.push(request.path);
    return Stream.make(jsonFrame({ stream: request.path.includes("-base") ? "base\n" : "derived\n" }));
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(servicePlan),
        buildKey: "named-source",
        onOutput: (text) =>
          Effect.sync(() => {
            outputs.push(text);
          }),
      },
      { providerId, api: { request, stream }, sourceEnv: {} },
    ),
  );

  // Then
  expect(posted).toHaveLength(2);
  expect(outputs).toEqual(["derived\n"]);
});

test("succeeds without an output sink", async () => {
  // When
  const digest = await Effect.runPromise(
    runBuild({ stream: streamedApi([jsonFrame({ aux: { Digest: "sha256:only" } })]) }),
  );

  // Then
  expect(digest).toBe("sha256:only");
});

test("redacts proxy credentials from the build source environment in an HTTP reason", async () => {
  // Given a daemon reason that echoes the bare password of HTTPS_PROXY.
  const password = "source-proxy-hunter2";
  const username = "sourceproxyuser";
  const failure = await Effect.runPromise(
    Effect.flip(
      runBuild({
        requestStatus: 400,
        requestBody: JSON.stringify({ message: `proxy rejected ${password} for ${username}` }),
        sourceEnv: { HTTPS_PROXY: `http://${username}:${password}@127.0.0.1:3128` },
      }),
    ),
  );

  // Then
  expect(failure.message).toContain("Container image build failed with HTTP 400.");
  expect(failure.message).not.toContain(password);
  expect(failure.message).not.toContain(username);
});

test("redacts proxy credentials carried in artifact build args", async () => {
  // Given a build arg proxy URL that the daemon echoes in its HTTP reason.
  const context = await mkdtemp(join(tmpdir(), "lando-build-proxy-args-"));
  try {
    await writeFile(join(context, "Dockerfile"), "FROM alpine:3.20\n");
    const password = "args-proxy-hunter2";
    const username = "argsproxyuser";
    const request = () =>
      Effect.succeed({
        status: 400,
        body: JSON.stringify({ message: `proxy rejected ${username}:${password}` }),
      });
    const servicePlan: ServicePlan = {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      artifact: {
        kind: "build",
        context: AbsolutePath.make(context),
        spec: PortablePath.make("Dockerfile"),
        args: { HTTPS_PROXY: `http://${username}:${password}@127.0.0.1:3128` },
      },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    };

    // When
    const failure = await Effect.runPromise(
      Effect.flip(
        buildContainerArtifact(
          {
            app: appId,
            service: serviceName,
            plan: plan(servicePlan),
            buildKey: "proxy-args",
          },
          { providerId, api: { request }, sourceEnv: {} },
        ),
      ),
    );

    // Then
    expect(failure._tag).toBe("ProviderUnavailableError");
    expect(failure.message).toContain("proxy rejected");
    expect(failure.message).toContain("[redacted]");
    expect(failure.message).not.toContain(password);
    expect(failure.message).not.toContain(username);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});

test("keeps an internal stream failure internal even when it carries a numeric status", async () => {
  // Given
  const internal = new ProviderInternalError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "Container runtime stream failed.",
    details: { status: 500 },
    remediation: "test",
  });

  // When
  const failure = await Effect.runPromise(Effect.flip(runBuild({ stream: () => Stream.fail(internal) })));

  // Then
  expect(failure._tag).toBe("ProviderInternalError");
});

test("keeps the original cause when re-tagging a streamed non-2xx transport failure", async () => {
  // Given
  const cause = new Error("socket reset");
  const unavailable = new ProviderUnavailableError({
    providerId: "podman",
    operation: "buildArtifact",
    message: "Container runtime stream request failed with HTTP 400.",
    details: { status: 400, body: JSON.stringify({ message: "bad build" }) },
    remediation: "test",
    cause,
  });

  // When
  const failure = await Effect.runPromise(Effect.flip(runBuild({ stream: () => Stream.fail(unavailable) })));

  // Then
  expect(failure._tag).toBe("ProviderUnavailableError");
  expect(failure.cause).toBe(cause);
});
