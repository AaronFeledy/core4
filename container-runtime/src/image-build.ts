import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { Effect } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ServicePlan } from "@lando/sdk/schema";
import type { ArtifactBuildSpec, ArtifactRef } from "@lando/sdk/services";

export interface ContainerBuildHttpRequest {
  readonly method: "POST";
  readonly path: `/${string}`;
  readonly headers?: Readonly<Record<string, string>>;
  readonly stdin?: AsyncIterable<Uint8Array>;
}

export interface ContainerBuildHttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface ContainerBuildHttpApi {
  readonly request?: (
    request: ContainerBuildHttpRequest,
  ) => Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError>;
}

export interface ContainerBuildOptions {
  readonly providerId: string;
  readonly api: ContainerBuildHttpApi;
}

interface BuildStep {
  readonly command: ReadonlyArray<string>;
}

const textEncoder = new TextEncoder();
const zeroBlock = new Uint8Array(512);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

const dockerfileForDerivedBuild = (baseRef: string, steps: ReadonlyArray<BuildStep>): string => {
  return [
    `FROM ${baseRef}`,
    ...steps.map((step) => `RUN ${step.command.map(shellQuote).join(" ")}`),
    "",
  ].join("\n");
};

const serviceBuildSteps = (service: ServicePlan): ReadonlyArray<BuildStep> => {
  const extension = service.extensions["@lando/core/service-features"];
  if (!isRecord(extension) || !Array.isArray(extension.buildSteps)) return [];
  return extension.buildSteps.flatMap((step) => {
    if (!isRecord(step) || !Array.isArray(step.command)) return [];
    const command = step.command.filter((part): part is string => typeof part === "string");
    return command.length === step.command.length ? [{ command }] : [];
  });
};

const deterministicRef = (input: ArtifactBuildSpec): string =>
  `lando-build-${input.plan.provider}-${input.service}-${input.buildKey.slice(0, 24)}`.replace(
    /[^a-zA-Z0-9_.-]/gu,
    "-",
  );

const writeOctal = (header: Uint8Array, offset: number, length: number, value: number): void => {
  const encoded = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  header.set(textEncoder.encode(encoded), offset);
  header[offset + length - 1] = 0;
};

const writeString = (header: Uint8Array, offset: number, length: number, value: string): void => {
  header.set(textEncoder.encode(value.slice(0, length)), offset);
};

const tarEntry = (name: string, content: Uint8Array, mode = 0o644): Uint8Array => {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeOctal(header, 148, 8, checksum);
  const padding = (512 - (content.byteLength % 512)) % 512;
  const entry = new Uint8Array(512 + content.byteLength + padding);
  entry.set(header, 0);
  entry.set(content, 512);
  return entry;
};

async function* tarStream(entries: ReadonlyArray<readonly [string, Uint8Array]>): AsyncGenerator<Uint8Array> {
  for (const [name, content] of entries) yield tarEntry(name, content);
  yield zeroBlock;
  yield zeroBlock;
}

const contextEntries = async (root: string): Promise<ReadonlyArray<readonly [string, Uint8Array]>> => {
  const walk = async (dir: string): Promise<ReadonlyArray<readonly [string, Uint8Array]>> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      dirents.map(async (dirent) => {
        const path = join(dir, dirent.name);
        if (dirent.isDirectory()) return walk(path);
        if (!dirent.isFile()) return [];
        const name = relative(root, path).split(sep).join("/");
        return [[name, await readFile(path)] as const];
      }),
    );
    return nested.flat();
  };
  await stat(root);
  return walk(root);
};

const buildPath = (input: ArtifactBuildSpec, tag: string, derived: boolean): `/${string}` => {
  const params = new URLSearchParams({ t: tag });
  const artifact = input.plan.services[input.service]?.artifact;
  if (!derived && artifact?.kind === "build") {
    params.set("dockerfile", artifact.spec ?? "Dockerfile");
    if (artifact.args !== undefined) params.set("buildargs", JSON.stringify(artifact.args));
    if (artifact.target !== undefined) params.set("target", artifact.target);
  } else {
    params.set("dockerfile", "Dockerfile");
  }
  return `/build?${params.toString()}`;
};

const requestBuild = (
  request: NonNullable<ContainerBuildHttpApi["request"]>,
  options: ContainerBuildOptions,
  path: `/${string}`,
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
): Effect.Effect<ContainerBuildHttpResponse, ProviderUnavailableError | ProviderInternalError> =>
  request({
    method: "POST",
    path,
    headers: { "Content-Type": "application/x-tar" },
    stdin: tarStream(entries),
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderUnavailableError || cause instanceof ProviderInternalError
        ? cause
        : new ProviderUnavailableError({
            providerId: options.providerId,
            operation: "buildArtifact",
            message: "Container image build request failed.",
            cause,
          }),
    ),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: options.providerId,
              operation: "buildArtifact",
              message: `Container image build failed with HTTP ${response.status}.`,
              details: { status: response.status },
            }),
          ),
    ),
  );

const parseDigest = (body: string): string | undefined => {
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && isRecord(parsed.aux) && typeof parsed.aux.Digest === "string")
        return parsed.aux.Digest;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
    }
  }
  return undefined;
};

export const buildContainerArtifact = (
  input: ArtifactBuildSpec,
  options: ContainerBuildOptions,
): Effect.Effect<ArtifactRef, ProviderUnavailableError | ProviderInternalError> =>
  Effect.gen(function* () {
    const request = options.api.request;
    if (request === undefined) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `${options.providerId} buildArtifact requires a container API request client.`,
        }),
      );
    }
    const service = input.plan.services[input.service];
    if (service === undefined) {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `Service ${input.service} is not present in the app plan.`,
        }),
      );
    }
    const artifact = service.artifact;
    const steps = serviceBuildSteps(service);
    const tag = deterministicRef(input);
    let response: ContainerBuildHttpResponse;
    if (artifact?.kind === "build") {
      const entries = yield* Effect.tryPromise({
        try: () => contextEntries(artifact.context),
        catch: (cause) =>
          new ProviderInternalError({
            providerId: options.providerId,
            operation: "buildArtifact",
            message: "Unable to read artifact build context.",
            cause,
          }),
      });
      const baseTag = steps.length === 0 ? tag : `${tag}-base`;
      response = yield* requestBuild(request, options, buildPath(input, baseTag, false), entries);
      if (steps.length > 0) {
        response = yield* requestBuild(request, options, buildPath(input, tag, true), [
          ["Dockerfile", textEncoder.encode(dockerfileForDerivedBuild(baseTag, steps))],
        ]);
      }
    } else if (artifact?.kind === "ref" && steps.length > 0) {
      response = yield* requestBuild(request, options, buildPath(input, tag, true), [
        ["Dockerfile", textEncoder.encode(dockerfileForDerivedBuild(artifact.ref, steps))],
      ]);
    } else {
      return yield* Effect.fail(
        new ProviderInternalError({
          providerId: options.providerId,
          operation: "buildArtifact",
          message: `Service ${input.service} has no artifact build inputs.`,
        }),
      );
    }
    const digest = parseDigest(response.body);
    return { providerId: input.plan.provider, ref: tag, ...(digest === undefined ? {} : { digest }) };
  });
