import { Effect } from "effect";

import { AppId, type HealthcheckPlan, ServiceName } from "../schema/index.ts";
import { ContractFailure } from "./_shared.ts";

import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  CertificateResult,
  CertificateSpec,
} from "../services/index.ts";

const caContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `CertificateAuthority contract failed: ${assertion}`, assertion, details });

const requireCaContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(caContractFailure(assertion, details));

export const runCaContract = (ca: CertificateAuthorityShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireCaContract(
      typeof ca.id === "string" && ca.id.length > 0,
      "id is a non-empty string",
      ca.id,
    );

    yield* ca.setup({ force: false }).pipe(Effect.mapError((d) => caContractFailure("setup resolves", d)));

    const certResult = yield* ca
      .issueCert({ cn: "test.lndo.site", sans: ["*.test.lndo.site"] })
      .pipe(Effect.mapError((d) => caContractFailure("issueCert resolves", d)));

    yield* requireCaContract(
      typeof certResult.certPath === "string" && certResult.certPath.length > 0,
      "issueCert result has non-empty certPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.keyPath === "string" && certResult.keyPath.length > 0,
      "issueCert result has non-empty keyPath",
      certResult,
    );
    yield* requireCaContract(
      typeof certResult.caPath === "string" && certResult.caPath.length > 0,
      "issueCert result has non-empty caPath",
      certResult,
    );

    yield* ca
      .setup({ force: false, skipTrustInstall: true })
      .pipe(Effect.mapError((d) => caContractFailure("setup with skipTrustInstall resolves", d)));
  });

export const makeTestCertificateAuthority = (): CertificateAuthorityShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: CaSetupOptions }>).push({ op: "setup", opts });
      }),
    issueCert: (spec) =>
      Effect.sync((): CertificateResult => {
        (calls as Array<{ op: "issueCert"; spec: CertificateSpec }>).push({ op: "issueCert", spec });
        return {
          certPath: `/tmp/test-certs/${spec.cn}.crt`,
          keyPath: `/tmp/test-certs/${spec.cn}.key`,
          caPath: "/tmp/test-certs/ca.crt",
        };
      }),
    calls,
  };
};

export const TestCertificateAuthority: CertificateAuthorityShape = makeTestCertificateAuthority();

import type { SshAgentSocket, SshServiceShape, SshSetupOptions } from "../services/index.ts";

const sshContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `SshService contract failed: ${assertion}`, assertion, details });

const requireSshContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(sshContractFailure(assertion, details));

export const runSshServiceContract = (ssh: SshServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireSshContract(
      typeof ssh.id === "string" && ssh.id.length > 0,
      "id is a non-empty string",
      ssh.id,
    );

    yield* ssh.setup({ force: false }).pipe(Effect.mapError((d) => sshContractFailure("setup resolves", d)));

    const socketResult = yield* ssh
      .getAgentSocket(AppId.make("contract-test-app"))
      .pipe(Effect.mapError((d) => sshContractFailure("getAgentSocket resolves", d)));

    yield* requireSshContract(
      typeof socketResult.socketPath === "string" && socketResult.socketPath.length > 0,
      "getAgentSocket result has non-empty socketPath",
      socketResult,
    );

    yield* ssh
      .setup({ force: true })
      .pipe(Effect.mapError((d) => sshContractFailure("setup with force:true resolves", d)));
  });

export const makeTestSshService = (): SshServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: SshSetupOptions }
    | { readonly op: "getAgentSocket"; readonly appId: AppId }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        (calls as Array<{ op: "setup"; opts: SshSetupOptions }>).push({ op: "setup", opts });
      }),
    getAgentSocket: (appId) =>
      Effect.sync((): SshAgentSocket => {
        (calls as Array<{ op: "getAgentSocket"; appId: AppId }>).push({ op: "getAgentSocket", appId });
        return { socketPath: `/tmp/test-ssh/${String(appId)}.sock`, appId };
      }),
    calls,
  };
};

export const TestSshService: SshServiceShape = makeTestSshService();

import type { HealthcheckResult, HealthcheckRunError, HealthcheckRunnerShape } from "../services/index.ts";

const healthcheckContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HealthcheckRunner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHealthcheckContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(healthcheckContractFailure(assertion, details));

export const runHealthcheckContract = (
  runner: HealthcheckRunnerShape,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHealthcheckContract(
      typeof runner.id === "string" && runner.id.length > 0,
      "id is a non-empty string",
      runner.id,
    );

    const testPlan: HealthcheckPlan = {
      kind: "command",
      command: ["sh", "-c", "exit 0"],
      intervalSeconds: 5,
      timeoutSeconds: 30,
      retries: 3,
    };

    const result = yield* runner
      .run(testPlan, AppId.make("contract-test-app"), ServiceName.make("web"))
      .pipe(Effect.mapError((d: HealthcheckRunError) => healthcheckContractFailure("run resolves", d)));

    yield* requireHealthcheckContract(
      typeof result.healthy === "boolean",
      "run result has boolean healthy",
      result,
    );
    yield* requireHealthcheckContract(
      typeof result.attempts === "number" && result.attempts > 0,
      "run result has positive attempts",
      result,
    );
  });

export const makeTestHealthcheckRunner = (): HealthcheckRunnerShape & {
  readonly calls: ReadonlyArray<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }>;
} => {
  const calls: Array<{
    readonly plan: HealthcheckPlan;
    readonly appId: AppId;
    readonly service: ServiceName;
  }> = [];
  return {
    id: "test",
    run: (plan, appId, service) =>
      Effect.sync((): HealthcheckResult => {
        calls.push({ plan, appId, service });
        return { healthy: true, service, attempts: 1 };
      }),
    calls,
  };
};

export const TestHealthcheckRunner: HealthcheckRunnerShape = makeTestHealthcheckRunner();

import type { PortCollision, ScanResult, UrlScannerShape } from "../services/index.ts";

const scannerContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `UrlScanner contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireScannerContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(scannerContractFailure(assertion, details));

export const runScannerContract = (scanner: UrlScannerShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireScannerContract(
      typeof scanner.id === "string" && scanner.id.length > 0,
      "id is a non-empty string",
      scanner.id,
    );

    const testAppId = AppId.make("contract-test-app");

    const scanResult = yield* scanner
      .scan(testAppId)
      .pipe(Effect.mapError((d) => scannerContractFailure("scan resolves", d)));

    yield* requireScannerContract(
      scanResult.appId === testAppId,
      "scan result appId matches input",
      scanResult,
    );
    yield* requireScannerContract(
      Array.isArray(scanResult.endpoints),
      "scan result has endpoints array",
      scanResult,
    );

    const collisions = yield* scanner
      .detectCollisions([testAppId])
      .pipe(Effect.mapError((d) => scannerContractFailure("detectCollisions resolves", d)));

    yield* requireScannerContract(
      Array.isArray(collisions),
      "detectCollisions result is an array",
      collisions,
    );
  });

export const makeTestUrlScanner = (): UrlScannerShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  >;
} => {
  const calls: Array<
    | { readonly op: "scan"; readonly appId: AppId }
    | { readonly op: "detectCollisions"; readonly appIds: ReadonlyArray<AppId> }
  > = [];
  return {
    id: "test",
    scan: (appId) =>
      Effect.sync((): ScanResult => {
        calls.push({ op: "scan", appId });
        return { appId, endpoints: [] };
      }),
    detectCollisions: (appIds) =>
      Effect.sync((): ReadonlyArray<PortCollision> => {
        calls.push({ op: "detectCollisions", appIds });
        return [];
      }),
    calls,
  };
};

export const TestUrlScanner: UrlScannerShape = makeTestUrlScanner();

import type {
  HostProxyMechanism,
  HostProxyServiceShape,
  HostProxySetupOptions,
  HostProxyStatus,
} from "../services/index.ts";

const HOST_PROXY_DEFAULT_BASE_DOMAIN = "lndo.site";
const HOST_PROXY_DEFAULT_LOOPBACK = "127.0.0.1";

const hostProxyContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `HostProxyService contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireHostProxyContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(hostProxyContractFailure(assertion, details));

export const runHostProxyContract = (service: HostProxyServiceShape): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    yield* requireHostProxyContract(
      typeof service.id === "string" && service.id.length > 0,
      "id is a non-empty string",
      service.id,
    );

    yield* service
      .setup({ mode: "auto" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'auto' }) resolves", d)));

    const activeStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after setup", d)));

    yield* requireHostProxyContract(
      typeof activeStatus.active === "boolean",
      "status.active is a boolean",
      activeStatus,
    );
    yield* requireHostProxyContract(
      activeStatus.mode === "auto" || activeStatus.mode === "none",
      "status.mode is auto or none",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.baseDomain === "string" && activeStatus.baseDomain.length > 0,
      "status.baseDomain is a non-empty string",
      activeStatus,
    );
    yield* requireHostProxyContract(
      typeof activeStatus.loopback === "string" && activeStatus.loopback.length > 0,
      "status.loopback is a non-empty string",
      activeStatus,
    );

    yield* service
      .setup({ mode: "none" })
      .pipe(Effect.mapError((d) => hostProxyContractFailure("setup({ mode: 'none' }) resolves", d)));

    const noneStatus = yield* service
      .status()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("status() resolves after opt-out", d)));

    yield* requireHostProxyContract(
      noneStatus.mode === "none" && noneStatus.active === false,
      "status reports mode='none' and inactive after opt-out",
      noneStatus,
    );

    yield* service
      .teardown()
      .pipe(Effect.mapError((d) => hostProxyContractFailure("teardown() resolves", d)));
  });

export const makeTestHostProxyService = (): HostProxyServiceShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly options: HostProxySetupOptions }
    | { readonly op: "status" }
    | { readonly op: "teardown" }
  > = [];

  let current: HostProxyStatus = {
    active: false,
    mode: "auto",
    mechanism: "none",
    baseDomain: HOST_PROXY_DEFAULT_BASE_DOMAIN,
    loopback: HOST_PROXY_DEFAULT_LOOPBACK,
  };

  const pickMechanism = (mode: HostProxySetupOptions["mode"]): HostProxyMechanism =>
    mode === "none" ? "skipped" : "etc-hosts";

  return {
    id: "test",
    setup: (options) =>
      Effect.sync(() => {
        calls.push({ op: "setup", options });
        current = {
          active: options.mode !== "none",
          mode: options.mode,
          mechanism: pickMechanism(options.mode),
          baseDomain: options.baseDomain ?? HOST_PROXY_DEFAULT_BASE_DOMAIN,
          loopback: options.loopback ?? HOST_PROXY_DEFAULT_LOOPBACK,
        };
      }),
    status: () =>
      Effect.sync((): HostProxyStatus => {
        calls.push({ op: "status" });
        return current;
      }),
    teardown: () =>
      Effect.sync(() => {
        calls.push({ op: "teardown" });
        current = {
          active: false,
          mode: current.mode,
          mechanism: "none",
          baseDomain: current.baseDomain,
          loopback: current.loopback,
        };
      }),
    calls,
  };
};

export const TestHostProxyService: HostProxyServiceShape = makeTestHostProxyService();
