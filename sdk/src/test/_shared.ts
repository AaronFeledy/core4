import { DateTime, Effect, Schema, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type PlanMetadata,
  PortablePath,
  ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "../schema/index.ts";
import type { ExecChunk } from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

export const TEST_APP_ID = AppId.make("myapp");
export const TEST_SERVICE_NAME = ServiceName.make("web");
export const TEST_PROVIDER_ID = Schema.decodeUnknownSync(ProviderId)("test");
export const TEST_COPY_SOURCE = Schema.decodeUnknownSync(AbsolutePath)("/tmp/lando-copy-in.tar");
export const TEST_SERVICE_PATH = Schema.decodeUnknownSync(PortablePath)("/app");
export const TEST_VOLUME_PATH = Schema.decodeUnknownSync(PortablePath)("/data/payload");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const utf8 = (value: string): Uint8Array => textEncoder.encode(value);

export const decodeUtf8 = (value: Uint8Array): string => textDecoder.decode(value);

export const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const streamBytes = (payload: Uint8Array): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield payload;
  },
});

export const collectByteStream = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<Uint8Array, E, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((chunks) => concatBytes(Array.from(chunks))),
  );

export const collectStdoutBytes = <E, R>(
  stream: Stream.Stream<ExecChunk, E, R>,
): Effect.Effect<Uint8Array, E | ContractFailure, R> =>
  stream.pipe(
    Stream.runCollect,
    Effect.flatMap((chunks) => {
      const collected = Array.from(chunks);
      const exit = collected.find((chunk): chunk is { readonly exitCode: number } => "exitCode" in chunk);
      if (exit !== undefined && exit.exitCode !== 0) {
        return Effect.fail(contractFailure("runStream exits successfully", { exitCode: exit.exitCode }));
      }

      return Effect.succeed(
        concatBytes(
          collected.flatMap((chunk) => ("kind" in chunk && chunk.kind === "stdout" ? [chunk.chunk] : [])),
        ),
      );
    }),
  );

export const cloneBytes = (payload: Uint8Array): Uint8Array => new Uint8Array(payload);

export const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
};

export const sampleBytes = (...bytes: ReadonlyArray<number>): Uint8Array => new Uint8Array(bytes);

export const testCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "copy",
  serviceFileCopy: "exec",
  artifactExport: true,
  artifactImport: true,
  ephemeralMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

export const planMetadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
  source: "@lando/sdk/test",
  runtime: 4,
};

export const makeTestServicePlan = (providerId: ProviderId): ServicePlan => ({
  name: TEST_SERVICE_NAME,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: [
    "node",
    "-e",
    "console.log('lando-contract-ready'); setInterval(() => console.log('lando-contract-ready'), 1000)",
  ],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: planMetadata,
  extensions: {},
});

export const makeTestAppPlan = (providerId: ProviderId): AppPlan => {
  const testServicePlan = makeTestServicePlan(providerId);

  return {
    id: TEST_APP_ID,
    name: "My App",
    slug: "myapp",
    root: AbsolutePath.make("/tmp/lando-sdk-contract-myapp"),
    provider: providerId,
    services: { [TEST_SERVICE_NAME]: testServicePlan },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: planMetadata,
    extensions: {},
  };
};

export const contractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `RuntimeProvider contract failed: ${assertion}`,
    assertion,
    details,
  });

export const requireContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(contractFailure(assertion, details));

export const mapProviderFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    contractFailure(assertion, details);

export const mapProviderOrContractFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    details instanceof ContractFailure ? details : contractFailure(assertion, details);

export const isStream = (value: unknown): boolean => Stream.StreamTypeId in Object(value);

export const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;
export const OPTIONAL_CAPABILITY_KEYS = new Set<keyof typeof ProviderCapabilities.fields>(["hostProxy"]);
export const REQUIRED_CAPABILITY_KEYS = CAPABILITY_KEYS.filter((key) => !OPTIONAL_CAPABILITY_KEYS.has(key));

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
