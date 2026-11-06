import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { resolveTraefikPublication } from "../src/global-services/traefik.ts";
import {
  AcquisitionState,
  persistPortAcquisition,
  readAcquisitionState,
} from "../src/port-acquisition-state.ts";
import { defaultAcquisitionFingerprint } from "../src/port-acquisition.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import { socketProxyPolkitHeader, socketProxyUnitHeader } from "../src/socket-proxy-helper.ts";
import { POLKIT_RULE_PATH, SOCKET_UNIT_PATHS } from "../src/socket-proxy-units.ts";
import { makeHarness } from "./proxy-tls-harness.ts";

const common = {
  httpPort: 80,
  httpsPort: 443,
  notices: [],
  fingerprint: defaultAcquisitionFingerprint(),
};
const activeHelper = {
  ...common,
  mode: "socket-helper",
  helperInstalled: true,
  socketsActive: true,
  bindHttpPort: 38080,
  bindHttpsPort: 38443,
} as const;

// Plain JSON produced by classification, helper acquisition, reuse, and confirmation.
const currentRecords = [
  ...(["direct", "occupied-hop", "needs-helper"] as const).flatMap((mode) =>
    [undefined, false, true].map((helperInstalled) => ({
      ...common,
      mode,
      ...(helperInstalled === undefined ? {} : { helperInstalled, socketsActive: false as const }),
    })),
  ),
  activeHelper,
  { ...activeHelper, appliedFingerprint: common.fingerprint },
  { ...common, mode: "direct", helperInstalled: false, appliedFingerprint: common.fingerprint },
] as const;

test.each(currentRecords)("reads existing $mode records without changing their contents", async (record) => {
  const { dependencies, files } = makeHarness();
  files.set(acquisitionStateFile(dependencies.paths), JSON.stringify(record));

  const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));

  expect(state).toEqual(record);
  expect(Schema.decodeUnknownSync(AcquisitionState)(record)).toEqual(record);
});

test.each([
  { ...common, mode: "socket-helper", helperInstalled: true, socketsActive: true },
  { ...activeHelper, helperInstalled: false },
  { ...activeHelper, socketsActive: false },
  { ...common, mode: "direct", socketsActive: true },
  { ...common, mode: "occupied-hop", bindHttpPort: 38080 },
  { ...common, mode: "needs-helper", bindHttpsPort: 38443 },
])("rejects contradictory $mode records and safely re-acquires", async (record) => {
  const { dependencies, files } = makeHarness();
  files.set(acquisitionStateFile(dependencies.paths), JSON.stringify(record));

  const previous = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));
  const decision = await Effect.runPromise(persistPortAcquisition(dependencies));
  const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));

  expect(previous).toBeUndefined();
  expect(decision).toEqual({ ...common, mode: "direct" });
  expect(state).toEqual({ ...common, mode: "direct", helperInstalled: false, socketsActive: false });
  expect(resolveTraefikPublication(state, "127.0.0.1")).toEqual({
    http: 80,
    https: 443,
    bindAddress: "127.0.0.1",
  });
});

test.each(["direct", "occupied-hop"] as const)("round-trips fresh %s acquisition", async (mode) => {
  const harness = makeHarness();
  const dependencies = {
    ...harness.dependencies,
    probeBind: (_host: string, port: number) =>
      Effect.succeed(
        mode === "occupied-hop" && port < 1024
          ? { kind: "EACCES" as const, code: "EACCES" as const }
          : { kind: "success" as const },
      ),
  };

  const decision = await Effect.runPromise(persistPortAcquisition(dependencies));
  const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));

  expect(decision.mode).toBe(mode);
  expect(state).toEqual({ ...decision, mode, helperInstalled: false, socketsActive: false });
  expect(resolveTraefikPublication(state, "127.0.0.1")).toEqual({
    http: mode === "direct" ? 80 : 8080,
    https: mode === "direct" ? 443 : 8443,
    bindAddress: "127.0.0.1",
  });
});

test.each(["direct", "occupied-hop", "needs-helper"] as const)(
  "round-trips an owned %s pair through the reuse writer",
  async (mode) => {
    const harness = makeHarness();
    const record = { ...common, mode, httpPort: 8080, httpsPort: 8443 };
    harness.files.set(acquisitionStateFile(harness.dependencies.paths), JSON.stringify(record));
    const dependencies = {
      ...harness.dependencies,
      probeBind: (_host: string, port: number) =>
        Effect.succeed(
          port === 8080 || port === 8443
            ? { kind: "EADDRINUSE" as const, code: "EADDRINUSE" as const }
            : { kind: "success" as const },
        ),
      globalApp: {
        ...harness.dependencies.globalApp,
        ownedPublishPorts: () => Effect.succeed([8080, 8443]),
      },
    };

    const decision = await Effect.runPromise(persistPortAcquisition(dependencies));
    const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));

    expect(decision).toMatchObject({ mode, httpPort: 8080, httpsPort: 8443 });
    expect(state).toEqual({ ...record, notices: decision.notices, helperInstalled: false });
  },
);

test("round-trips an already active owned helper without installing or starting it", async () => {
  const harness = makeHarness();
  const root = "/lando";
  const units = new Map<string, string>(
    SOCKET_UNIT_PATHS.map((path) => [
      path,
      `${socketProxyUnitHeader(root)}\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:${path.includes("https") ? 38443 : 38080}\n`,
    ]),
  );
  units.set(POLKIT_RULE_PATH, socketProxyPolkitHeader(root));
  const dependencies = {
    ...harness.dependencies,
    socketProxy: {
      user: "test",
      userDataRoot: root,
      hasHostSystemd: () => true,
      exists: (path: string) => Effect.succeed(units.has(path)),
      readText: (path: string) => Effect.succeed(units.get(path) ?? ""),
      processRunner: {
        run: () => {
          throw new Error("active helper must not run commands");
        },
        stream: () => {
          throw new Error("unused stream");
        },
        streamWithExit: () => {
          throw new Error("unused stream");
        },
      },
      privilege: {
        elevate: () => {
          throw new Error("active helper must not elevate");
        },
      },
      classifyOverride: {
        http: {
          bind: { kind: "EADDRINUSE" as const, code: "EADDRINUSE" as const },
          forward: { kind: "failure" as const },
          holderSystemdUnit: "lando-proxy-http.socket",
        },
        https: {
          bind: { kind: "EADDRINUSE" as const, code: "EADDRINUSE" as const },
          forward: { kind: "failure" as const },
          holderSystemdUnit: "lando-proxy-https.socket",
        },
      },
    },
  };

  await Effect.runPromise(persistPortAcquisition(dependencies));
  const state = await Effect.runPromise(readAcquisitionState(dependencies.fileSystem, dependencies.paths));

  expect(state).toEqual(activeHelper);
  expect(resolveTraefikPublication(state, "127.0.0.1")).toEqual({
    http: 38080,
    https: 38443,
    bindAddress: "127.0.0.1",
  });
});
