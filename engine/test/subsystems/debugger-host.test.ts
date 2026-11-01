import { expect, test } from "bun:test";
import { ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  DEBUGGER_HOST_ALIAS,
  GlobalConfig,
  HOST_GATEWAY_TARGET,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";
import {
  type DebuggerHostDiscovery,
  applyDebuggerHost,
  discoverWindowsDebuggerHost,
  resolveDebuggerHost,
  stripDebuggerHost,
  windowsDefaultGateway,
} from "../../src/subsystems/debugger-host.ts";

const fixture = (consumer = true): AppPlan => {
  const metadata: AppPlan["metadata"] = {
    resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    source: "test",
    runtime: 4,
  };
  return {
    id: AppId.make("demo"),
    name: "demo",
    slug: "demo",
    root: AbsolutePath.make("/app/demo"),
    provider: ProviderId.make("lando"),
    metadata,
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    services: {
      [ServiceName.make("php")]: {
        name: ServiceName.make("php"),
        type: "lando",
        provider: ProviderId.make("lando"),
        primary: true,
        environment: {},
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        metadata,
        extensions: {},
        hostAliases: [
          { hostname: "host.lando.internal", ip: HOST_GATEWAY_TARGET },
          ...(consumer ? [{ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET }] : []),
        ],
      },
    },
  };
};
const route = (iface = "eth0", gateway = "01301BAC", metric = 0, flags = "0003") =>
  `${iface}\t00000000\t${gateway}\t${flags}\t0\t0\t${metric}\t00000000\t0\t0\t0`;
const discovery = (mode = "nat", release = "6.18-microsoft-standard-WSL2"): DebuggerHostDiscovery => ({
  platform: "wsl",
  readFile: async (path) => (path.endsWith("osrelease") ? release : route()),
  runner: { run: () => Effect.succeed({ exitCode: 0, stdout: `${mode}\n`, stderr: "" }) },
});
const configured = (host?: string) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)(host === undefined ? {} : { debugger: { host } });
  return ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) });
};

test("does not read config or spawn when no service consumes the alias", async () => {
  // Given
  const config = configured("windows");
  // When
  const result = await Effect.runPromise(
    resolveDebuggerHost(fixture(false), {
      ...discovery(),
      runner: { run: () => Effect.die("unexpected spawn") },
    }).pipe(
      Effect.provideService(ConfigService, {
        ...config,
        get: () => Effect.die("unexpected config read"),
      }),
    ),
  );
  // Then
  expect(result).toBeUndefined();
});

for (const host of [undefined, "192.0.2.40", "2001:db8::40"]) {
  test(`resolves configured host ${host ?? "unset"} without host discovery`, async () => {
    // Given
    const plan = fixture();
    // When
    const result = await Effect.runPromise(
      resolveDebuggerHost(plan, {
        ...discovery(),
        runner: { run: () => Effect.die("unexpected spawn") },
      }).pipe(Effect.provideService(ConfigService, configured(host))),
    );
    // Then
    expect(result).toBe(host);
  });
}

test("resolves the Windows NAT gateway through global debugger.host", async () => {
  // Given
  const plan = fixture();
  // When
  const result = await Effect.runPromise(
    resolveDebuggerHost(plan, discovery()).pipe(Effect.provideService(ConfigService, configured("windows"))),
  );
  // Then
  expect(result).toBe("172.27.48.1");
});

test("uses NAT when wslinfo is missing", async () => {
  // Given
  const options = discovery();
  // When
  const result = await Effect.runPromise(
    discoverWindowsDebuggerHost({
      ...options,
      runner: {
        run: () =>
          Effect.fail(
            new ProcessExecError({
              cmd: "wslinfo",
              message: "missing",
              errno: -2,
              remediation: "install WSL",
            }),
          ),
      },
    }),
  );
  // Then
  expect(result).toBe("172.27.48.1");
});

for (const mode of ["mirrored", "virtioproxy", "none", ""]) {
  test(`rejects ${mode || "empty"} networking mode with explicit-address remediation`, async () => {
    // Given
    const options = discovery(mode);
    // When
    const error = await Effect.runPromise(discoverWindowsDebuggerHost(options).pipe(Effect.flip));
    // Then
    expect(error.reason).toBe("networking-mode");
    expect(error.networkingMode).toBe(mode);
    expect(error.remediation).toContain("lando config set debugger.host <address>");
    expect(error.remediation).toContain("lando config unset debugger.host");
  });
}

for (const release of ["4.4.0-Microsoft", "6.18-generic"]) {
  test(`rejects non-WSL2 kernel ${release} before spawning`, async () => {
    // Given
    const options = { ...discovery("nat", release), runner: { run: () => Effect.die("unexpected spawn") } };
    // When
    const error = await Effect.runPromise(discoverWindowsDebuggerHost(options).pipe(Effect.flip));
    // Then
    expect(error.reason).toBe("not-wsl");
  });
}

test("rejects a non-Linux platform before reading the host", async () => {
  // Given
  const options: DebuggerHostDiscovery = {
    ...discovery(),
    platform: "win32",
    readFile: () => Promise.reject(new Error("unexpected read")),
  };
  // When
  const error = await Effect.runPromise(discoverWindowsDebuggerHost(options).pipe(Effect.flip));
  // Then
  expect(error.reason).toBe("not-wsl");
});

test("rejects failed wslinfo instead of assuming NAT", async () => {
  // Given
  const options = {
    ...discovery(),
    runner: { run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "failed" }) },
  };
  // When
  const error = await Effect.runPromise(discoverWindowsDebuggerHost(options).pipe(Effect.flip));
  // Then
  expect(error.reason).toBe("wslinfo-failed");
});

for (const failure of [
  new ProcessTimeoutError({ cmd: "wslinfo", message: "timeout", elapsedMs: 2000, remediation: "retry" }),
  new ProcessExecError({ cmd: "wslinfo", message: "denied", errno: -13, remediation: "permissions" }),
]) {
  test(`rejects wslinfo ${failure._tag}`, async () => {
    // Given
    const options = { ...discovery(), runner: { run: () => Effect.fail(failure) } };
    // When
    const error = await Effect.runPromise(discoverWindowsDebuggerHost(options).pipe(Effect.flip));
    // Then
    expect(error.reason).toBe("wslinfo-failed");
  });
}

test.each(["eth1", "tun0"])("uses eth0 despite a lower metric on %s", (iface) => {
  // Given
  const table = `${route(iface, "0100000A", 0)}\n${route("eth0", "01301BAC", 100)}`;
  // When
  const result = windowsDefaultGateway(table);
  // Then
  expect(result).toBe("172.27.48.1");
});

test("chooses the lowest metric on eth0", () => {
  // Given
  const table = `${route("eth0", "0100000A", 100)}\n${route("eth0", "01301BAC", 10)}`;
  // When
  const result = windowsDefaultGateway(table);
  // Then
  expect(result).toBe("172.27.48.1");
});

test.each(["eth1", "tun0"])("rejects a valid %s default when eth0 is absent", (iface) => {
  // Given
  const table = route(iface);
  // When
  const result = windowsDefaultGateway(table);
  // Then
  expect(result).toBeUndefined();
});

test.each([
  [route("eth0", "00000000"), route("eth0", "0100000A", 0, "0001"), "malformed"].join("\n"),
  route("eth1"),
  route("tun0"),
  `${route("eth0", "00000000")}\n${route("eth1")}`,
])("fails discovery with no usable eth0 default: %s", async (table) => {
  // Given
  const options = discovery();
  // When
  const error = await Effect.runPromise(
    discoverWindowsDebuggerHost({
      ...options,
      readFile: async (path) => (path.endsWith("osrelease") ? "microsoft-standard" : table),
    }).pipe(Effect.flip),
  );
  // Then
  expect(error).toMatchObject({ _tag: "DebuggerHostUnavailableError", reason: "no-default-route" });
});

test.each([
  route("eth0", "00000000"),
  route("eth0", "01301BAC", 0, "0001"),
  "eth0 0100000A 01301BAC 0003 0 0 0 00000000",
  "eth0 00000000 01301BAC 0003 0 0 0 00FFFFFF",
  "eth0 00000000 invalid! 0003 0 0 0 00000000",
  "eth0 00000000 01301BAC invalid 0 0 0 00000000",
  "eth0 00000000 01301BAC 0002 0 0 0 00000000",
  "eth0 00000000 01301BAC 0003 0 0 -1 00000000",
  "eth0 00000000 01301BAC 0003 0 0 1x 00000000",
  "eth0 00000000 01301BAC",
])("rejects invalid eth0 default without falling back to eth1: %s", (invalid) => {
  // Given
  const table = `${invalid}\n${route("eth1", "0100000A", 100)}`;
  // When
  const result = windowsDefaultGateway(table);
  // Then
  expect(result).toBeUndefined();
});

test("rewrites only the debugger alias and strips it back to a neutral plan", () => {
  // Given
  const plan = fixture();
  // When
  const applied = applyDebuggerHost(plan, "2001:db8::40");
  // Then
  expect(applied.services[ServiceName.make("php")]?.hostAliases).toEqual([
    { hostname: "host.lando.internal", ip: HOST_GATEWAY_TARGET },
    { hostname: DEBUGGER_HOST_ALIAS, ip: "2001:db8::40" },
  ]);
  expect(stripDebuggerHost(applied)).toEqual(plan);
  expect(applyDebuggerHost(plan, undefined)).toBe(plan);
});

test("reads a new gateway on each resolution without changing the original plan", async () => {
  // Given
  const plan = fixture();
  let gateway = "01301BAC";
  const options = {
    ...discovery(),
    readFile: async (path: string) =>
      path.endsWith("osrelease") ? "microsoft-standard" : route("eth0", gateway),
  };
  const resolve = () =>
    Effect.runPromise(
      resolveDebuggerHost(plan, options).pipe(Effect.provideService(ConfigService, configured("windows"))),
    );
  const before = await resolve();
  gateway = "02301BAC";
  // When
  const after = await resolve();
  // Then
  expect(before).toBe("172.27.48.1");
  expect(after).toBe("172.27.48.2");
  expect(plan.services[ServiceName.make("php")]?.hostAliases[1]?.ip).toBe(HOST_GATEWAY_TARGET);
});
