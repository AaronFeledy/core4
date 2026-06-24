// Catalog-private legacy service-plan contract regression suite. Relocated from
// `@lando/sdk/test` when the SDK adopted the `ServiceType` resolve contract:
// these assertions drive pre-composition plan bodies via `__legacyToServicePlan`
// until the catalog migrates onto base + features.
import { Effect, Either, Schema } from "effect";

import {
  type EndpointPlan,
  type HealthcheckPlan,
  type HostPlatform,
  LandofileShape,
  ProviderCapabilities,
  type ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";
import { createSecretRedactor } from "@lando/sdk/secrets";
import type { ServiceTypeHostFacts } from "@lando/sdk/services";
import { ContractFailure } from "@lando/sdk/test";

import type { LegacyServicePlanInput, LegacyServiceType } from "../../src/services/legacy.ts";

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const CONTRACT_MATRIX_PLATFORMS: ReadonlyArray<HostPlatform> = ["darwin", "linux", "win32", "wsl"];

const CAPABILITY_KEYS = Object.keys(ProviderCapabilities.fields) as ReadonlyArray<
  keyof typeof ProviderCapabilities.fields
>;

const serviceContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceType contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceContractFailure(assertion, details));

/** Required base env keys every catalog service must emit. */
const SERVICE_LANDO_IDENTITY_KEYS: ReadonlyArray<string> = [
  "LANDO",
  "LANDO_APP_NAME",
  "LANDO_APP_KIND",
  "LANDO_MAIL_HOST",
  "LANDO_MAIL_PORT",
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
  readonly serviceType: LegacyServiceType;
  /** Landofile service block fed to `__legacyToServicePlan`. */
  readonly landofileService: Record<string, unknown>;
  readonly providerId: ProviderId;
  readonly platform: HostPlatform;
  readonly providerCapabilities: ProviderCapabilities;
  readonly serviceName?: string;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly expectations: ServiceContractExpectations;
}

const isRuntimeServicePlan = Schema.is(ServicePlan);

const argvJoin = (argv: string | ReadonlyArray<string> | undefined): string => {
  if (argv === undefined) return "";
  return typeof argv === "string" ? argv : argv.join(" ");
};

const flattenServicePlanArgv = (plan: ServicePlan): string =>
  `${argvJoin(plan.command)} ${argvJoin(plan.entrypoint)}`;

const redactTokens = (value: string, tokens: ReadonlyArray<string>): string =>
  createSecretRedactor(tokens).redact(value);

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
 * Run the legacy `ServiceType` plan-body contract assertions: the type exposes
 * a non-empty id and a callable `__legacyToServicePlan`, the planned
 * `ServicePlan` decodes through the schema, declared expectations for type /
 * endpoints / healthcheck / `LANDO_*` env / default credentials are satisfied,
 * and known default-credential plaintext is not leaked into `command` /
 * `entrypoint` argv.
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
      typeof serviceType.__legacyToServicePlan === "function",
      "service type __legacyToServicePlan is callable",
      typeof serviceType.__legacyToServicePlan,
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
      plan = serviceType.__legacyToServicePlan({
        name: serviceName,
        service: decodedService,
        appRoot,
        appName,
        provider: input.providerId,
        primary: false,
        metadata: {
          resolvedAt: "2026-05-10T18:51:00Z",
          source: "@lando/service-lando/test/legacy/service-contract",
          runtime: 4,
        },
        host,
      } satisfies LegacyServicePlanInput);
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
        "service plan environment contains the LANDO_* identity keys",
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
 * Run the legacy service-type contract suite across every (`providerId`,
 * `platform`) cell. Required canonical platforms are `darwin`, `linux`,
 * `win32`, and `wsl`, enforced per declared provider.
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
