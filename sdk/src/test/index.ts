/**
 * Test helpers for the SDK provider and service contract suites.
 *
 * Every `RuntimeProvider` plugin MUST pass the contract suite before it can be
 * treated as conforming to the SDK surface.
 */
import { DateTime, Duration, Effect, Either, Schema, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type EndpointPlan,
  type HealthcheckPlan,
  type HostPlatform,
  LandofileShape,
  type PlanMetadata,
  ProviderCapabilities,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "../schema/index.ts";
import type {
  ExecChunk,
  LogChunk,
  RuntimeProviderShape,
  ServiceTypeHostFacts,
  ServiceTypeShape,
} from "../services/index.ts";

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  message: Schema.String,
  assertion: Schema.String,
  details: Schema.optional(Schema.Unknown),
}) {}

const TEST_APP_ID = AppId.make("myapp");
const TEST_SERVICE_NAME = ServiceName.make("web");
const TEST_PROVIDER_ID = ProviderId.make("test");

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

const makeTestServicePlan = (providerId: ProviderId): ServicePlan => ({
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

const makeTestAppPlan = (providerId: ProviderId): AppPlan => {
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
    metadata: planMetadata,
    extensions: {},
  };
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

const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const CONTRACT_MATRIX_PLATFORMS: ReadonlyArray<HostPlatform> = ["darwin", "linux", "win32", "wsl"];

/**
 * Run the `RuntimeProvider` contract assertions. Validates capability decode,
 * lifecycle method types, fixture apply/inspect/destroy round-trips, provider
 * identity, status, version fields, capability completeness, ApplyResult
 * shape, re-apply idempotency, list shape, and volume-preserving destroy.
 */
export const runProviderContract = (provider: RuntimeProviderShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const providerId = ProviderId.make(provider.id);
    const testAppPlan = makeTestAppPlan(providerId);
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(provider.capabilities);

    yield* requireContract(isNonEmptyString(provider.id), "provider exposes a non-empty id", provider.id);
    yield* requireContract(
      isNonEmptyString(provider.displayName),
      "provider exposes a non-empty displayName",
      provider.displayName,
    );
    yield* requireContract(
      isNonEmptyString(provider.version),
      "provider exposes a non-empty version",
      provider.version,
    );
    yield* requireContract(
      isNonEmptyString(provider.platform),
      "provider exposes a non-empty platform",
      provider.platform,
    );

    yield* requireContract(Either.isRight(capabilities), "capability matrix decodes", capabilities);
    for (const key of CAPABILITY_KEYS) {
      yield* requireContract(
        (provider.capabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `capability ${String(key)} is populated`,
        provider.capabilities,
      );
    }

    yield* requireContract(Effect.isEffect(provider.isAvailable), "isAvailable is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getStatus), "getStatus is Effect-typed");
    yield* requireContract(Effect.isEffect(provider.getVersions), "getVersions is Effect-typed");
    yield* requireContract(
      Effect.isEffect(provider.apply(testAppPlan, { reconcile: true })),
      "apply is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.start({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "start is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.stop({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "stop is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.restart({ app: TEST_APP_ID, service: TEST_SERVICE_NAME })),
      "restart is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(
        provider.exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] }),
      ),
      "exec is Effect-typed",
    );
    yield* requireContract(
      Effect.isEffect(provider.run({ image: "node:22-alpine", command: ["echo", "ok"] })),
      "run is Effect-typed",
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
    yield* requireContract(Effect.isEffect(provider.list({ app: TEST_APP_ID })), "list is Effect-typed");

    const available = yield* provider.isAvailable.pipe(
      Effect.mapError(mapProviderFailure("isAvailable resolves")),
    );
    yield* requireContract(typeof available === "boolean", "isAvailable resolves to a boolean", available);

    const status = yield* provider.getStatus.pipe(Effect.mapError(mapProviderFailure("getStatus resolves")));
    yield* requireContract(
      typeof status.running === "boolean",
      "getStatus returns a running boolean",
      status,
    );
    yield* requireContract(
      status.message === undefined || typeof status.message === "string",
      "getStatus message is a string when present",
      status,
    );

    const versions = yield* provider.getVersions.pipe(
      Effect.mapError(mapProviderFailure("getVersions resolves")),
    );
    yield* requireContract(
      isNonEmptyString(versions.provider),
      "getVersions returns a non-empty provider version",
      versions,
    );
    yield* requireContract(
      versions.runtime === undefined || typeof versions.runtime === "string",
      "getVersions runtime is a string when present",
      versions,
    );

    const applyResult = yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("apply succeeds for the contract fixture")),
    );
    yield* requireContract(
      typeof applyResult.changed === "boolean",
      "apply returns ApplyResult with a boolean changed field",
      applyResult,
    );

    yield* Effect.scoped(provider.apply(testAppPlan, { reconcile: true })).pipe(
      Effect.mapError(mapProviderFailure("re-apply under reconcile succeeds")),
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

    const execResult = yield* provider
      .exec({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { command: ["echo", "ok"] })
      .pipe(Effect.mapError(mapProviderFailure("exec returns a structured result")));
    yield* requireContract(
      typeof execResult.exitCode === "number",
      "exec result includes a numeric exitCode",
      execResult,
    );
    yield* requireContract(typeof execResult.stdout === "string", "exec result includes stdout", execResult);
    yield* requireContract(typeof execResult.stderr === "string", "exec result includes stderr", execResult);

    const logChunks = yield* Effect.timeoutFail(
      provider.logs({ app: TEST_APP_ID, service: TEST_SERVICE_NAME }, { follow: true, tail: 20 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunks) => Array.from(chunks)),
        Effect.mapError(mapProviderFailure("logs emits structured chunks")),
      ),
      {
        // 15s budget: live Docker/Podman log endpoints can take several
        // seconds to flush the first chunk on contended CI runners. The
        // assertion still fails closed if the stream never emits.
        duration: Duration.seconds(15),
        onTimeout: () => contractFailure("logs emits at least one chunk", []),
      },
    );
    yield* requireContract(logChunks.length > 0, "logs emits at least one chunk", logChunks);
    for (const chunk of logChunks) {
      yield* requireContract(chunk.service === TEST_SERVICE_NAME, "log chunk includes service name", chunk);
      yield* requireContract(
        chunk.stream === "stdout" || chunk.stream === "stderr",
        "log chunk includes stream name",
        chunk,
      );
      yield* requireContract(typeof chunk.line === "string", "log chunk includes a line", chunk);
    }

    const listed = yield* provider
      .list({ app: TEST_APP_ID })
      .pipe(Effect.mapError(mapProviderFailure("list resolves for the contract fixture")));
    yield* requireContract(
      Array.isArray(listed),
      "list returns an array of service runtime snapshots",
      listed,
    );

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: false })
      .pipe(Effect.mapError(mapProviderFailure("destroy accepts volumes:false")));

    yield* provider
      .destroy({ app: TEST_APP_ID }, { volumes: true })
      .pipe(Effect.mapError(mapProviderFailure("destroy succeeds for the contract fixture")));

    yield* requireContract(typeof provider.setup === "function", "setup is callable", provider.setup);
    const setupEffect = provider.setup({ force: false });
    yield* requireContract(Effect.isEffect(setupEffect), "setup returns an Effect", setupEffect);

    yield* requireContract(
      versions.bundle === undefined || typeof versions.bundle === "string",
      "getVersions bundle is a string when present",
      versions,
    );
  });

export type HostPlatformId = HostPlatform;

export interface SupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: true;
  readonly factory: () => Effect.Effect<RuntimeProviderShape, unknown>;
}

export interface UnsupportedContractCell {
  readonly platform: HostPlatformId;
  readonly supported: false;
  readonly skipReason: string;
}

export type ContractMatrixCell = SupportedContractCell | UnsupportedContractCell;

export interface ContractMatrixCellResult {
  readonly platform: HostPlatformId;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface ContractMatrixReport {
  readonly providerName: string;
  readonly results: ReadonlyArray<ContractMatrixCellResult>;
}

export interface ContractMatrixOptions {
  readonly providerName: string;
  readonly cells: ReadonlyArray<ContractMatrixCell>;
}

const isSupported = (cell: ContractMatrixCell): cell is SupportedContractCell => cell.supported === true;

export const runProviderContractMatrix = (
  options: ContractMatrixOptions,
): Effect.Effect<ContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: ContractMatrixCellResult[] = [];
    const seenPlatforms = new Set<HostPlatform>();

    for (const cell of options.cells) {
      yield* requireContract(!seenPlatforms.has(cell.platform), "matrix cell platform is unique", cell);
      seenPlatforms.add(cell.platform);
    }

    for (const platform of CONTRACT_MATRIX_PLATFORMS) {
      yield* requireContract(seenPlatforms.has(platform), "matrix declares every canonical host platform", {
        providerName: options.providerName,
        platform,
      });
    }

    for (const cell of options.cells) {
      if (isSupported(cell)) {
        yield* requireContract(
          typeof cell.factory === "function",
          "supported matrix cell declares a factory",
          cell,
        );

        const provider = yield* cell
          .factory()
          .pipe(Effect.mapError(mapProviderFailure(`matrix cell ${cell.platform} factory resolves`)));

        yield* requireContract(
          provider.platform === cell.platform,
          "matrix cell provider platform matches cell platform",
          { platform: cell.platform, providerPlatform: provider.platform },
        );
        yield* runProviderContract(provider);
        results.push({ platform: cell.platform, outcome: "passed" });
      } else {
        yield* requireContract(
          isNonEmptyString(cell.skipReason),
          "unsupported matrix cell declares a skip reason",
          cell,
        );
        results.push({ platform: cell.platform, outcome: "skipped", reason: cell.skipReason });
      }
    }

    return { providerName: options.providerName, results };
  });

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
      kind: "stdout",
      chunk: new TextEncoder().encode(command.command.join(" ")),
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

const serviceContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceType contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceContractFailure(assertion, details));

/** Identity env keys every catalog service must emit. */
const SERVICE_LANDO_IDENTITY_KEYS: ReadonlyArray<string> = [
  "LANDO",
  "LANDO_APP_NAME",
  "LANDO_APP_KIND",
  "LANDO_PROJECT",
  "LANDO_SERVICE_API",
  "LANDO_SERVICE_NAME",
  "LANDO_SERVICE_TYPE",
];

/** Deterministic per-platform host facts the service contract runner injects. */
const SERVICE_CONTRACT_HOST_FACTS: Record<HostPlatform, ServiceTypeHostFacts> = {
  linux: { os: "linux", user: "lando", uid: "1000", gid: "1000", home: "/home/lando" },
  wsl: { os: "linux", user: "lando", uid: "1000", gid: "1000", home: "/home/lando" },
  darwin: { os: "darwin", user: "lando", uid: "501", gid: "20", home: "/Users/lando" },
  win32: { os: "win32", user: "lando", uid: "0", gid: "0", home: "C:\\Users\\lando" },
};

/** Expected endpoint shape the runner asserts at least one match for. */
export interface EndpointExpectation {
  readonly port: number;
  readonly protocol: "http" | "https" | "tcp" | "udp" | "unix";
}

/**
 * Expected healthcheck probe shape. Matches against `HealthcheckPlan`:
 * - `tcp`: matches `kind: "tcp"` with the same port, or a `kind: "command"`
 *   shell probe whose argv contains a `/dev/tcp/.../<port>` or
 *   `localhost:<port>` substring.
 * - `http`: matches `kind: "http"` whose URL ends with the expected path
 *   (and optional port), or a `kind: "command"` curl/wget probe whose argv
 *   contains both an HTTP host token (`localhost`/`127.0.0.1`) and the
 *   expected path.
 */
export type HealthcheckExpectation =
  | { readonly kind: "tcp"; readonly port: number }
  | { readonly kind: "http"; readonly port?: number; readonly path: string };

/** Per-cell expectations the service contract runner enforces. */
export interface ServiceContractExpectations {
  readonly type: string;
  readonly endpoints: ReadonlyArray<EndpointExpectation>;
  readonly healthcheck: HealthcheckExpectation;
  /**
   * Environment keys the catalog service is required to populate with a
   * default value at plan time. Asserts each is present (non-undefined) in
   * `plan.environment`.
   */
  readonly defaultCredentialEnvKeys: ReadonlyArray<string>;
  /**
   * Environment keys whose values must not appear inside `plan.command` or
   * `plan.entrypoint`. Used for services that define deterministic default
   * credentials in `plan.environment`; the contract checks that the plaintext
   * values stay out of the rendered argv.
   */
  readonly defaultCredentialSecretEnvKeys?: ReadonlyArray<string>;
}

/** Single cell the service contract runner exercises. */
export interface ServiceContractInput {
  readonly serviceType: ServiceTypeShape;
  /** Landofile service block fed to `toServicePlan`. */
  readonly landofileService: Record<string, unknown>;
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly providerCapabilities: ProviderCapabilities;
  readonly serviceName?: string;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly expectations: ServiceContractExpectations;
}

/** Reference `ServiceTypeShape` the SDK ships for in-suite contract tests. */
export const TestServiceType: ServiceTypeShape = {
  id: "test",
  toServicePlan: (input) => {
    const appName = input.appName !== undefined && input.appName.length > 0 ? input.appName : "myapp";
    const slug =
      appName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "app";

    const environment: Record<string, string> = {
      LANDO: "ON",
      LANDO_APP_NAME: appName,
      LANDO_APP_KIND: "user",
      LANDO_PROJECT: slug,
      LANDO_SERVICE_API: "4",
      LANDO_SERVICE_NAME: input.name,
      LANDO_SERVICE_TYPE: "test",
    };

    if (input.host !== undefined) {
      environment.LANDO_HOST_OS = input.host.os;
      environment.LANDO_HOST_USER = input.host.user;
      environment.LANDO_HOST_UID = input.host.uid;
      environment.LANDO_HOST_GID = input.host.gid;
      environment.LANDO_HOST_HOME = input.host.home;
    }

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(input.name),
      type: "test",
      provider: input.provider ?? ProviderId.make("test"),
      primary: input.primary ?? false,
      artifact: { kind: "ref", ref: "alpine:3.20" },
      environment,
      mounts: [],
      storage: [],
      endpoints: [{ port: 8080, protocol: "tcp", name: input.name }],
      routes: [],
      dependsOn: [],
      healthcheck: {
        kind: "command",
        command: ["sh", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 10,
      },
      hostAliases: [],
      metadata: input.metadata,
      extensions: {},
    });
  },
};

const isRuntimeServicePlan = Schema.is(ServicePlan);

const argvJoin = (argv: string | ReadonlyArray<string> | undefined): string => {
  if (argv === undefined) return "";
  return typeof argv === "string" ? argv : argv.join(" ");
};

const flattenServicePlanArgv = (plan: ServicePlan): string =>
  `${argvJoin(plan.command)} ${argvJoin(plan.entrypoint)}`;

const redactTokens = (value: string, tokens: ReadonlyArray<string>): string =>
  tokens.reduce(
    (redacted, token) => (token.length === 0 ? redacted : redacted.replaceAll(token, "[REDACTED]")),
    value,
  );

const commandContainsHostPort = (cmd: string, port: number): boolean => {
  const expectedPort = String(port);
  return new RegExp(`(?:127\\.0\\.0\\.1|localhost):${expectedPort}(?!\\d)`).test(cmd);
};

const commandContainsTcpProbePort = (cmd: string, port: number): boolean => {
  const expectedPort = String(port);
  return (
    new RegExp(`/dev/tcp/(?:127\\.0\\.0\\.1|localhost)/${expectedPort}(?!\\d)`).test(cmd) ||
    commandContainsHostPort(cmd, port)
  );
};

const matchesHealthcheck = (hc: HealthcheckPlan, expected: HealthcheckExpectation): boolean => {
  if (expected.kind === "tcp") {
    if (hc.kind === "tcp") return hc.port === expected.port;
    if (hc.kind === "command") return commandContainsTcpProbePort(argvJoin(hc.command), expected.port);
    return false;
  }

  // expected.kind === "http"
  if (hc.kind === "http") {
    if (expected.port !== undefined && hc.port !== undefined && hc.port !== expected.port) {
      return false;
    }
    return hc.url?.endsWith(expected.path) ?? false;
  }
  if (hc.kind === "command") {
    const cmd = argvJoin(hc.command);
    const hostToken = cmd.includes("localhost") || cmd.includes("127.0.0.1");
    const portToken = expected.port === undefined || commandContainsHostPort(cmd, expected.port);
    return hostToken && portToken && cmd.includes(expected.path);
  }
  return false;
};

/**
 * Run the `ServiceType` contract assertions: the type exposes a non-empty id
 * and a callable `toServicePlan`, the planned `ServicePlan` decodes through
 * the schema, declared expectations for type / endpoints / healthcheck /
 * `LANDO_*` env / default credentials are satisfied, and known default-
 * credential plaintext is not leaked into `command`/`entrypoint` argv.
 */
export const runServiceContract = (input: ServiceContractInput): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const serviceType = input.serviceType;
    const serviceName = input.serviceName ?? "web";
    const appName = input.appName ?? "myapp";
    const appRoot = input.appRoot ?? `/srv/apps/${appName}`;
    const host = SERVICE_CONTRACT_HOST_FACTS[input.platform];
    const capabilities = Schema.decodeUnknownEither(ProviderCapabilities)(input.providerCapabilities);

    yield* requireServiceContract(
      isNonEmptyString(serviceType.id),
      "service type exposes a non-empty id",
      serviceType.id,
    );
    yield* requireServiceContract(
      typeof serviceType.toServicePlan === "function",
      "service type toServicePlan is callable",
      typeof serviceType.toServicePlan,
    );
    yield* requireServiceContract(
      Either.isRight(capabilities),
      "service provider capabilities decode",
      capabilities,
    );
    for (const key of CAPABILITY_KEYS) {
      yield* requireServiceContract(
        (input.providerCapabilities as Readonly<Record<string, unknown>>)[key] !== undefined,
        `service provider capability ${String(key)} is populated`,
        input.providerCapabilities,
      );
    }

    const decodedLandofile = Schema.decodeUnknownEither(LandofileShape)({
      name: appName,
      services: { [serviceName]: input.landofileService },
    });
    yield* requireServiceContract(
      Either.isRight(decodedLandofile),
      "landofile service input decodes through LandofileShape",
      Either.isLeft(decodedLandofile) ? decodedLandofile.left : undefined,
    );
    if (Either.isLeft(decodedLandofile)) return;

    const services = decodedLandofile.right.services;
    const decodedService = services?.[ServiceName.make(serviceName)];
    yield* requireServiceContract(
      decodedService !== undefined,
      "landofile decode preserves the requested service entry",
      { serviceName },
    );
    if (decodedService === undefined) return;

    let plan: ServicePlan;
    try {
      plan = serviceType.toServicePlan({
        name: serviceName,
        service: decodedService,
        appRoot,
        appName,
        provider: input.providerId,
        primary: false,
        metadata: {
          resolvedAt: "2026-05-10T18:51:00Z",
          source: "@lando/sdk/test/service-contract",
          runtime: 4,
        },
        host,
      });
    } catch (cause) {
      yield* Effect.fail(
        serviceContractFailure("service plan decodes through the ServicePlan schema", String(cause)),
      );
      return;
    }

    const planIsValid = isRuntimeServicePlan(plan);
    yield* requireServiceContract(planIsValid, "service plan decodes through the ServicePlan schema", {
      keys: typeof plan === "object" && plan !== null ? Object.keys(plan) : typeof plan,
    });
    if (!planIsValid) return;

    yield* requireServiceContract(
      plan.type === input.expectations.type,
      "service plan type matches expectations",
      { actual: plan.type, expected: input.expectations.type },
    );
    yield* requireServiceContract(
      plan.provider === input.providerId,
      "service plan provider matches the requested provider",
      { actual: plan.provider, expected: input.providerId },
    );

    yield* requireServiceContract(
      plan.endpoints.length === 0 || input.providerCapabilities.hostPortPublish !== "none",
      "service plan endpoint publishing is supported by provider capabilities",
      { hostPortPublish: input.providerCapabilities.hostPortPublish, endpoints: plan.endpoints },
    );
    yield* requireServiceContract(
      plan.healthcheck === undefined || input.providerCapabilities.serviceHealth !== "none",
      "service plan healthchecks are supported by provider capabilities",
      { serviceHealth: input.providerCapabilities.serviceHealth, healthcheck: plan.healthcheck },
    );
    yield* requireServiceContract(
      plan.storage.length === 0 || input.providerCapabilities.persistentStorage,
      "service plan persistent storage is supported by provider capabilities",
      { persistentStorage: input.providerCapabilities.persistentStorage, storage: plan.storage },
    );
    yield* requireServiceContract(
      plan.mounts.length === 0 || input.providerCapabilities.bindMounts,
      "service plan bind mounts are supported by provider capabilities",
      { bindMounts: input.providerCapabilities.bindMounts, mounts: plan.mounts },
    );

    yield* requireServiceContract(plan.endpoints.length > 0, "service plan emits at least one endpoint", {
      endpoints: plan.endpoints,
    });

    for (const expected of input.expectations.endpoints) {
      const found = plan.endpoints.some(
        (ep: EndpointPlan) => ep.port === expected.port && ep.protocol === expected.protocol,
      );
      yield* requireServiceContract(found, "service plan emits expected endpoint ports", {
        expected,
        actual: plan.endpoints,
      });
    }

    yield* requireServiceContract(plan.healthcheck !== undefined, "service plan declares a healthcheck", {
      plan: plan.name,
    });

    if (plan.healthcheck !== undefined) {
      yield* requireServiceContract(
        matchesHealthcheck(plan.healthcheck, input.expectations.healthcheck),
        "service plan healthcheck matches expected probe",
        { actual: plan.healthcheck, expected: input.expectations.healthcheck },
      );
    }

    for (const key of SERVICE_LANDO_IDENTITY_KEYS) {
      yield* requireServiceContract(
        isNonEmptyString(plan.environment[key]),
        "service plan environment contains the §6.9 LANDO_* identity keys",
        { missing: key, environment: Object.keys(plan.environment) },
      );
    }

    for (const key of input.expectations.defaultCredentialEnvKeys) {
      yield* requireServiceContract(
        plan.environment[key] !== undefined,
        "service plan environment defines declared default-credential env keys",
        { missing: key, environment: Object.keys(plan.environment) },
      );
    }

    if (input.expectations.defaultCredentialSecretEnvKeys !== undefined) {
      const argv = flattenServicePlanArgv(plan);
      const secretValues = input.expectations.defaultCredentialSecretEnvKeys
        .map((key) => plan.environment[key])
        .filter((value): value is string => value !== undefined);
      for (const [index, value] of secretValues.entries()) {
        yield* requireServiceContract(
          value.length === 0 || !argv.includes(value),
          "service plan default-credential values are not leaked into argv",
          {
            secretIndex: index,
            secretEnvKeys: input.expectations.defaultCredentialSecretEnvKeys,
            argv: redactTokens(argv, secretValues),
          },
        );
      }
    }
  });

export interface SupportedServiceContractCell {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly supported: true;
  readonly factory: () => ServiceContractInput;
}

export interface UnsupportedServiceContractCell {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly supported: false;
  readonly skipReason: string;
}

export type ServiceContractMatrixCell = SupportedServiceContractCell | UnsupportedServiceContractCell;

export interface ServiceContractMatrixCellResult {
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly outcome: "passed" | "skipped";
  readonly reason?: string;
}

export interface ServiceContractMatrixReport {
  readonly serviceTypeId: string;
  readonly results: ReadonlyArray<ServiceContractMatrixCellResult>;
}

export interface ServiceContractMatrixOptions {
  readonly serviceTypeId: string;
  readonly cells: ReadonlyArray<ServiceContractMatrixCell>;
}

const isSupportedServiceCell = (cell: ServiceContractMatrixCell): cell is SupportedServiceContractCell =>
  cell.supported === true;

/**
 * Run the service-type contract suite across every (`providerId`, `platform`)
 * cell. Required canonical platforms are `darwin`, `linux`, `win32`, and `wsl`
 * (per `CONTRACT_MATRIX_PLATFORMS`), enforced per declared provider.
 */
export const runServiceContractMatrix = (
  options: ServiceContractMatrixOptions,
): Effect.Effect<ServiceContractMatrixReport, ContractFailure> =>
  Effect.gen(function* () {
    const results: ServiceContractMatrixCellResult[] = [];
    const seen = new Set<string>();
    const providerPlatforms = new Map<ProviderId, Set<HostPlatform>>();

    for (const cell of options.cells) {
      const key = `${cell.providerId}::${cell.platform}`;
      yield* requireServiceContract(
        !seen.has(key),
        "service contract matrix cell (providerId, platform) is unique",
        cell,
      );
      seen.add(key);
      const platforms = providerPlatforms.get(cell.providerId) ?? new Set<HostPlatform>();
      platforms.add(cell.platform);
      providerPlatforms.set(cell.providerId, platforms);
    }

    for (const [providerId, platforms] of providerPlatforms) {
      for (const platform of CONTRACT_MATRIX_PLATFORMS) {
        yield* requireServiceContract(
          platforms.has(platform),
          "service contract matrix declares every canonical host platform per provider",
          { serviceTypeId: options.serviceTypeId, providerId, platform },
        );
      }
    }

    for (const cell of options.cells) {
      if (isSupportedServiceCell(cell)) {
        yield* requireServiceContract(
          typeof cell.factory === "function",
          "supported service contract matrix cell declares a factory",
          cell,
        );
        const contractInput = cell.factory();
        yield* requireServiceContract(
          contractInput.providerId === cell.providerId,
          "service contract matrix factory provider matches cell provider",
          { cellProviderId: cell.providerId, inputProviderId: contractInput.providerId },
        );
        yield* requireServiceContract(
          contractInput.platform === cell.platform,
          "service contract matrix factory platform matches cell platform",
          { cellPlatform: cell.platform, inputPlatform: contractInput.platform },
        );
        yield* requireServiceContract(
          contractInput.serviceType.id === options.serviceTypeId,
          "service contract matrix factory service type matches matrix service type",
          { serviceTypeId: options.serviceTypeId, inputServiceTypeId: contractInput.serviceType.id },
        );
        yield* runServiceContract(contractInput);
        results.push({
          providerId: cell.providerId,
          platform: cell.platform,
          outcome: "passed",
        });
      } else {
        yield* requireServiceContract(
          isNonEmptyString(cell.skipReason),
          "unsupported service contract matrix cell declares a skip reason",
          cell,
        );
        results.push({
          providerId: cell.providerId,
          platform: cell.platform,
          outcome: "skipped",
          reason: cell.skipReason,
        });
      }
    }

    return { serviceTypeId: options.serviceTypeId, results };
  });
