/**
 * @lando/sdk/test — provider contract suite + library API contract suite.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
import { DateTime, Effect, Either, Schema, Stream } from "effect";

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
import type { ExecChunk, LogChunk, RuntimeProviderShape } from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

const TEST_PROVIDER_ID = ProviderId.make("test");
const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");

const testCapabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const planMetadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-10T18:51:00Z"),
  source: "@lando/sdk/test",
  runtime: 4,
};

const testServicePlan: ServicePlan = {
  name: TEST_SERVICE_NAME,
  type: "node",
  provider: TEST_PROVIDER_ID,
  primary: true,
  environment: {},
  mounts: [
    {
      type: "bind",
      source: AbsolutePath.make("/srv/apps/myapp"),
      target: PortablePath.make("/app"),
      readOnly: false,
      realization: "passthrough",
    },
  ],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: planMetadata,
  extensions: {},
};

const testAppPlan: AppPlan = {
  id: TEST_APP_ID,
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/srv/apps/myapp"),
  provider: TEST_PROVIDER_ID,
  services: { [TEST_SERVICE_NAME]: testServicePlan },
  routes: [],
  networks: [],
  stores: [],
  metadata: planMetadata,
  extensions: {},
};

const contractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `RuntimeProvider contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(contractFailure(assertion, details));

const mapProviderFailure =
  (assertion: string) =>
  (details: unknown): ContractFailure =>
    contractFailure(assertion, details);

const isStream = (value: unknown): boolean => Stream.StreamTypeId in Object(value);

export interface ProviderContractSuiteOptions {
  /** Tag identifier used in test descriptions. */
  readonly providerId: string;
  /** `RuntimeProvider` service object under test. */
  readonly provider: RuntimeProviderShape;
}

/**
 * Run the Phase 1 `RuntimeProvider` contract assertions.
 */
export const runProviderContract = (provider: RuntimeProviderShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(provider.capabilities);

    yield* requireContract(Either.isRight(capabilities), "capability matrix decodes", capabilities);
    yield* requireContract(
      Effect.isEffect(provider.apply(testAppPlan, { reconcile: true })),
      "apply is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.destroy({ app: TEST_APP_ID }, { volumes: true })),
      "destroy is Effect-typed",
    );
    yield* requireContract(
      isStream(
        provider.execStream({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "execStream returns a Stream of stdio chunks",
    );
    yield* requireContract(
      isStream(provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: false })),
      "logs returns a Stream of LogChunk values",
    );
    yield* requireContract(
      Effect.isEffect(provider.inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "inspect is Effect-typed",
    );

    const snapshot = yield* provider
      .inspect({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })
      .pipe(Effect.mapError(mapProviderFailure("inspect returns a structured snapshot")));

    yield* requireContract(snapshot.app === TEST_APP_ID, "inspect snapshot includes app id", snapshot);
    yield* requireContract(
      snapshot.service === TEST_SERVICE_NAME,
      "inspect snapshot includes service name",
      snapshot,
    );
    yield* requireContract(
      snapshot.providerId === provider.id,
      "inspect snapshot includes provider id",
      snapshot,
    );
    yield* requireContract(typeof snapshot.status === "string", "inspect snapshot includes status", snapshot);
  });

/**
 * Compatibility alias for the original SDK test-suite stub export.
 */
export const runProviderContractSuite = (
  options: ProviderContractSuiteOptions,
): Effect.Effect<void, ContractFailure> => runProviderContract(options.provider);

/**
 * In-memory `RuntimeProvider` reference implementation for SDK contract tests.
 */
export const TestRuntimeProvider: RuntimeProviderShape = {
  id: TEST_PROVIDER_ID,
  displayName: "Test Runtime Provider",
  version: "0.0.0-test",
  platform: "linux",
  capabilities: testCapabilities,

  isAvailable: Effect.succeed(true),
  setup: (_options) => Effect.void,
  getStatus: Effect.succeed({ running: true, message: "ready" }),
  getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test" }),

  buildArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: `${spec.service}:test` }),
  pullArtifact: (spec) => Effect.succeed({ providerId: TEST_PROVIDER_ID, ref: spec.ref }),
  removeArtifact: (_ref) => Effect.void,

  apply: (_plan, _options) => Effect.succeed({ changed: false }),
  start: (_target) => Effect.void,
  stop: (_target) => Effect.void,
  restart: (_target) => Effect.void,
  destroy: (_target, _options) => Effect.void,

  exec: (_target, command) =>
    Effect.succeed({
      exitCode: 0,
      stdout: command.command.join(" "),
      stderr: "",
    }),
  execStream: (_target, command) => {
    const stdoutChunk: ExecChunk = {
      stream: "stdout",
      data: new TextEncoder().encode(command.command.join(" ")),
    };
    const exitChunk: ExecChunk = { exitCode: 0 };

    return Stream.make(stdoutChunk, exitChunk);
  },
  run: (spec) =>
    Effect.succeed({
      exitCode: 0,
      stdout: spec.command.join(" "),
      stderr: "",
    }),
  logs: (target, _options) => {
    const chunk: LogChunk = {
      service: target.service,
      stream: "stdout",
      line: "ready",
    };

    return Stream.make(chunk);
  },
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: TEST_PROVIDER_ID,
      status: "running",
    }),
  list: (filter) =>
    Effect.succeed([
      {
        app: filter.app ?? TEST_APP_ID,
        service: TEST_SERVICE_NAME,
        providerId: TEST_PROVIDER_ID,
        status: "running",
      },
    ]),
};
