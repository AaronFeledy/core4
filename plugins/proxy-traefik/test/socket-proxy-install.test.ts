import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Cause, type Context, Effect, Exit, Schema } from "effect";
import {
  DEFAULT_BACKEND_HTTPS_TRY_LIST,
  DEFAULT_BACKEND_HTTP_TRY_LIST,
  DEFAULT_HTTPS_TRY_LIST,
  DEFAULT_HTTP_TRY_LIST,
} from "../src/port-acquisition.ts";

import { AcquisitionState } from "../src/port-acquisition-state.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import {
  classifySocketProxyArtifacts,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "../src/socket-proxy-helper.ts";
import {
  POLKIT_RULE_PATH,
  PROXYD_CANDIDATES,
  ProxydBinaryNotFound,
  SOCKET_UNIT_PATHS,
  discoverProxydBinary,
  installSocketProxy,
  isSocketProxyInstalled,
  renderPolkitRule,
  startSockets,
} from "../src/socket-proxy-install.ts";
import { resolveNeedsHelper } from "../src/socket-proxy-setup.ts";
import { buildInstallScript } from "../src/socket-proxy-units.ts";
import { makeAckStore } from "./observe-routes-fixture.ts";

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode = 1, stderr = "denied"): ProcessResult => ({ exitCode, stdout: "", stderr });

const failureTag = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const option = Cause.findErrorOption(exit.cause);
  if (option._tag !== "Some") throw new Error("expected a tagged failure");
  return option.value;
};

type RunCall = {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
};

const makeRunner = (
  handler: (input: ProcessSpawnOptions) => ProcessResult,
): {
  readonly service: Context.Service.Shape<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<RunCall>;
} => {
  const calls: RunCall[] = [];
  return {
    service: {
      run: (input) =>
        Effect.sync(() => {
          calls.push({ cmd: input.cmd, args: [...input.args] });
          return handler(input);
        }),
      stream: () => {
        throw new Error("stream is unused");
      },
      streamWithExit: () => {
        throw new Error("streamWithExit is unused");
      },
    },
    calls: () => [...calls],
  };
};

const makePrivilege = (
  result: ProcessResult | ((command: ReadonlyArray<string>) => ProcessResult),
): {
  readonly service: Context.Service.Shape<typeof PrivilegeService>;
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>;
} => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    service: {
      elevate: (command) =>
        Effect.sync(() => {
          calls.push([...command]);
          return typeof result === "function" ? result(command) : result;
        }),
    },
    calls: () => [...calls],
  };
};

const hostFiles = (present: Readonly<Record<string, string>> = {}) => {
  const files = new Map(Object.entries(present));
  return {
    exists: (path: string) => Effect.succeed(files.has(path)),
    readText: (path: string) =>
      files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
  };
};

const markedUnit = `${socketProxyUnitHeader("/lando")}\n[Unit]\n`;
const [packagedProxyd] = PROXYD_CANDIDATES;

describe("discoverProxydBinary", () => {
  test("checks usr lib path before lib path before command -v", async () => {
    // Given: only the second candidate exists on disk.
    const seen: string[] = [];
    const runner = makeRunner(() => ok("/usr/bin/systemd-socket-proxyd\n"));

    // When: discovery walks the candidate order.
    const found = await Effect.runPromise(
      discoverProxydBinary({
        exists: (path) =>
          Effect.sync(() => {
            seen.push(path);
            return path === PROXYD_CANDIDATES[1];
          }),
        processRunner: runner.service,
      }),
    );

    // Then: the lib path wins and command -v is not consulted.
    expect(seen).toEqual([...PROXYD_CANDIDATES]);
    expect(found).toBe(PROXYD_CANDIDATES[1]);
    expect(runner.calls()).toEqual([]);
  });

  test("falls back to command -v when both packaged paths are missing", async () => {
    // Given: neither packaged path exists.
    const runner = makeRunner(() => ok("/usr/local/bin/systemd-socket-proxyd\n"));

    // When: discovery exhausts packaged paths.
    const found = await Effect.runPromise(
      discoverProxydBinary({
        exists: () => Effect.succeed(false),
        processRunner: runner.service,
      }),
    );

    // Then: ProcessRunner ran `command -v systemd-socket-proxyd`.
    expect(found).toBe("/usr/local/bin/systemd-socket-proxyd");
    const invocation = runner.calls()[0];
    expect(invocation).toBeDefined();
    expect([invocation?.cmd, ...(invocation?.args ?? [])].join(" ")).toContain(
      "command -v systemd-socket-proxyd",
    );
  });

  test("fails ProxydBinaryNotFound when the binary is missing", async () => {
    // Given: no packaged path and command -v exits nonzero.
    const runner = makeRunner(() => fail(1, ""));

    // When: discovery runs to completion.
    const exit = await Effect.runPromiseExit(
      discoverProxydBinary({
        exists: () => Effect.succeed(false),
        processRunner: runner.service,
      }),
    );

    // Then: the tagged plugin-local failure is raised.
    const error = failureTag(exit);
    expect(error).toBeInstanceOf(ProxydBinaryNotFound);
    expect(Schema.is(ProxydBinaryNotFound)(error)).toBe(true);
  });
});

describe("renderPolkitRule", () => {
  test("allows only matching lando-proxy units and omits manage-unit-files", () => {
    // Given: the invoking user.
    // When: the polkit rule is rendered.
    const rule = renderPolkitRule("lando-dev", "/lando");

    // Then: the unit regex and manage-units action are present; manage-unit-files is not.
    expect(rule).toContain("org.freedesktop.systemd1.manage-units");
    expect(rule).toContain("/^lando-proxy-[a-z0-9_-]+\\.(socket|service)$/");
    expect(rule).not.toContain("manage-unit-files");
    expect(rule).toContain("lando-dev");
  });
});

describe("buildInstallScript", () => {
  test("locked elevated script rejects another root before any mutation", () => {
    const temp = mkdtempSync(join(tmpdir(), "lando-helper-install-"));
    const bin = join(temp, "bin");
    const units = join(temp, "units");
    const rules = join(temp, "rules");
    const log = join(temp, "mutation.log");
    mkdirSync(bin);
    mkdirSync(units);
    mkdirSync(rules);
    for (const name of ["systemctl", "chown", "chmod"]) {
      writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MUTATION_LOG"\n', { mode: 0o755 });
    }
    const foreignPath = join(units, "lando-proxy-http.socket");
    const foreign = socketProxyUnitHeader("/another-root");
    writeFileSync(foreignPath, foreign);
    const script = buildInstallScript({
      user: "lando-dev",
      userDataRoot: "/lando",
      binary: "/usr/lib/systemd/systemd-socket-proxyd",
      serviceType: "notify",
      httpTarget: 48080,
      httpsTarget: 48443,
    });
    try {
      const child = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          script
            .replaceAll("/etc/systemd/system", units)
            .replaceAll("/etc/polkit-1/rules.d", rules)
            .replaceAll("/run/lock/lando-proxy-helper.lock", join(temp, "helper.lock")),
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MUTATION_LOG: log },
        },
      );
      expect(child.exitCode).toBe(3);
      expect(existsSync(log)).toBe(false);
      expect(readFileSync(foreignPath, "utf8")).toBe(foreign);
      expect(existsSync(join(rules, "10-lando-proxy.rules"))).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("stamps all five artifacts and renders valid polkit JavaScript", () => {
    const root = '/lando/quoted "root"';
    const script = buildInstallScript({
      user: "lando-dev",
      userDataRoot: root,
      binary: "/usr/lib/systemd/systemd-socket-proxyd",
      serviceType: "notify",
      httpTarget: 38080,
      httpsTarget: 38443,
    });
    const artifacts = [...script.matchAll(/cat > (\S+) <<'LANDO_PROXY_EOF'\n([\s\S]*?)LANDO_PROXY_EOF/gu)];
    expect(artifacts).toHaveLength(5);
    expect(
      classifySocketProxyArtifacts(
        artifacts.map((match) => match[2]),
        root,
        [],
      ),
    ).toEqual({ kind: "owned" });
    const polkit = artifacts.find((match) => match[1] === POLKIT_RULE_PATH)?.[2] ?? "";
    expect(polkit.startsWith("// lando-proxy-socket-helper\n")).toBe(true);
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(polkit)).not.toThrow();
  });

  test("hops to supplied targets while listening on 80 and 443", () => {
    // Given: hop targets 8080/8443.
    // When: buildInstallScript is called with those hop targets.
    const script = buildInstallScript({
      user: "lando-dev",
      userDataRoot: "/lando",
      binary: "/usr/lib/systemd/systemd-socket-proxyd",
      serviceType: "notify",
      httpTarget: 8080,
      httpsTarget: 8443,
    });

    // Then: units listen on 80/443 and hop to 8080/8443, not 38080.
    expect(script).toContain("127.0.0.1:8080");
    expect(script).toContain("127.0.0.1:8443");
    expect(script).toContain("ListenStream=127.0.0.1:80\n");
    expect(script).toContain("ListenStream=127.0.0.1:443\n");
    expect(script).not.toContain("38080");
    expect(script).toContain("systemctl try-restart lando-proxy-http.service lando-proxy-https.service");
  });
});

describe("isSocketProxyInstalled", () => {
  test("recognizes this root's helper when the polkit rule is readable only by root", async () => {
    const files = new Map<string, string>(SOCKET_UNIT_PATHS.map((path) => [path, markedUnit]));
    const installed = await Effect.runPromise(
      isSocketProxyInstalled({
        userDataRoot: "/lando",
        exists: (path) => Effect.succeed(files.has(path) || path === POLKIT_RULE_PATH),
        readText: (path) => {
          const text = files.get(path);
          return text === undefined ? Effect.fail(new Error(`EACCES ${path}`)) : Effect.succeed(text);
        },
      }),
    );
    expect(installed).toBe(true);
  });
});

describe("installSocketProxy", () => {
  test.each(["/another-root", undefined])("leaves foreign helper %s untouched", async (owner) => {
    const content = owner === undefined ? "# lando-proxy-socket-helper" : socketProxyUnitHeader(owner);
    const access = hostFiles(Object.fromEntries(SOCKET_UNIT_PATHS.map((path) => [path, content])));
    const runner = makeRunner(() => ok());
    const privilege = makePrivilege(ok());
    const outcome = await Effect.runPromise(
      installSocketProxy({
        ...access,
        user: "lando-dev",
        userDataRoot: "/lando",
        processRunner: runner.service,
        privilege: privilege.service,
        httpTarget: 48080,
        httpsTarget: 48443,
      }),
    );
    expect(outcome.kind).toBe("foreign");
    expect(runner.calls()).toEqual([]);
    expect(privilege.calls()).toEqual([]);
  });

  test("maps an ownership race detected under the install lock to foreign", async () => {
    const privilege = makePrivilege(fail(3, ""));
    const outcome = await Effect.runPromise(
      installSocketProxy({
        ...hostFiles({ [packagedProxyd]: "binary" }),
        user: "lando-dev",
        userDataRoot: "/lando",
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 48080,
        httpsTarget: 48443,
      }),
    );
    expect(outcome.kind).toBe("foreign");
    const script = privilege.calls()[0]?.[2] ?? "";
    expect(script).toContain("command -v flock");
    expect(script).toMatch(/exit 4/);
    expect(script).toContain("flock -x 9");
    expect(script.indexOf("command -v flock")).toBeLessThan(script.indexOf("flock -x 9"));
    expect(script.indexOf("flock -x 9")).toBeLessThan(script.indexOf("cat >"));
  });

  test("setup never prompts, installs, or starts a foreign helper", async () => {
    const runner = makeRunner(() => ok());
    const privilege = makePrivilege(ok());
    const owner = "/another-root";
    const access = hostFiles({
      ...Object.fromEntries(SOCKET_UNIT_PATHS.map((path) => [path, socketProxyUnitHeader(owner)])),
      [POLKIT_RULE_PATH]: socketProxyPolkitHeader(owner),
      [owner]: "directory",
    });
    const resolved = await Effect.runPromise(
      resolveNeedsHelper(
        {
          ...access,
          user: "lando-dev",
          userDataRoot: "/lando",
          hasHostSystemd: () => true,
          autoApprove: true,
          processRunner: runner.service,
          privilege: privilege.service,
        },
        { httpTarget: 48080, httpsTarget: 48443 },
      ),
    );
    expect(resolved.helperInstalled).toBe(false);
    expect(resolved.socketsActive).toBe(false);
    expect(resolved.decision.notices.join(" ")).toContain(owner);
    expect(runner.calls()).toEqual([]);
    expect(privilege.calls()).toEqual([]);
  });

  test("recognizes a helper stamped with the canonical root behind an alias", async () => {
    const files = {
      ...Object.fromEntries(SOCKET_UNIT_PATHS.map((path) => [path, markedUnit])),
      [POLKIT_RULE_PATH]: socketProxyPolkitHeader("/lando"),
    };
    expect(
      await Effect.runPromise(
        isSocketProxyInstalled({
          ...hostFiles(files),
          userDataRoot: "/alias",
          realpath: () => Effect.succeed("/lando"),
        }),
      ),
    ).toBe(true);
  });

  test("elevates one script with units, polkit path, daemon-reload, and no enable", async () => {
    // Given: proxyd is at the first packaged path and units are not installed.
    const privilege = makePrivilege(ok());

    // When: install runs.
    const outcome = await Effect.runPromise(
      installSocketProxy({
        user: "lando-dev",
        userDataRoot: "/lando",
        exists: hostFiles({ [packagedProxyd]: "binary" }).exists,
        readText: hostFiles().readText,
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 8080,
        httpsTarget: 8443,
      }),
    );

    // Then: a single elevate writes all four units, the polkit rule, and daemon-reload.
    expect(outcome.kind).toBe("installed");
    expect(privilege.calls()).toHaveLength(1);
    const script = privilege.calls()[0]?.join(" ") ?? "";
    expect(script).toContain("lando-proxy-http.socket");
    expect(script).toContain("lando-proxy-http.service");
    expect(script).toContain("lando-proxy-https.socket");
    expect(script).toContain("lando-proxy-https.service");
    expect(script).toContain(POLKIT_RULE_PATH);
    expect(script).toContain("daemon-reload");
    expect(script).toContain("try-restart lando-proxy-http.service");
    expect(script).toContain("127.0.0.1:8080");
    expect(script).toContain("127.0.0.1:8443");
    expect(script).not.toContain("38080");
    expect(script).not.toContain("systemctl enable");
  });

  test("skips a second elevate when unit files already carry the marker", async () => {
    // Given: all four unit files exist with the content marker.
    const present = {
      ...Object.fromEntries(SOCKET_UNIT_PATHS.map((path) => [path, markedUnit])),
      [POLKIT_RULE_PATH]: socketProxyPolkitHeader("/lando"),
      "/etc/systemd/system/lando-proxy-http.service": `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:8080\n`,
      "/etc/systemd/system/lando-proxy-https.service": `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:8443\n`,
    };
    const privilege = makePrivilege(ok());
    const installedHost = hostFiles(present);
    const installHost = hostFiles({ ...present, [packagedProxyd]: "binary" });

    // When: install checks idempotency.
    const installed = await Effect.runPromise(
      isSocketProxyInstalled({
        userDataRoot: "/lando",
        exists: installedHost.exists,
        readText: installedHost.readText,
      }),
    );
    const outcome = await Effect.runPromise(
      installSocketProxy({
        user: "lando-dev",
        userDataRoot: "/lando",
        exists: installHost.exists,
        readText: installHost.readText,
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 8080,
        httpsTarget: 8443,
      }),
    );

    // Then: isInstalled is true and elevate is not invoked.
    expect(installed).toBe(true);
    expect(outcome.kind).toBe("already-installed");
    expect(privilege.calls()).toHaveLength(0);
  });

  test("rewrites units when an existing hop target differs", async () => {
    // Given: marked units whose ExecStart still hops to 38080/38443.
    const staleHttp = `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:38080\n`;
    const staleHttps = `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:38443\n`;
    const present = Object.fromEntries([
      ...SOCKET_UNIT_PATHS.map((path) => [path, markedUnit]),
      [POLKIT_RULE_PATH, socketProxyPolkitHeader("/lando")],
    ]);
    present["/etc/systemd/system/lando-proxy-http.service"] = staleHttp;
    present["/etc/systemd/system/lando-proxy-https.service"] = staleHttps;
    const privilege = makePrivilege(ok());
    const installHost = hostFiles({ ...present, [packagedProxyd]: "binary" });

    // When: install is asked to hop to 8080/8443.
    const outcome = await Effect.runPromise(
      installSocketProxy({
        user: "lando-dev",
        userDataRoot: "/lando",
        exists: installHost.exists,
        readText: installHost.readText,
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 8080,
        httpsTarget: 8443,
      }),
    );

    // Then: elevate rewrites units to the new hop pair.
    expect(outcome.kind).toBe("installed");
    expect(privilege.calls()).toHaveLength(1);
    const script = privilege.calls()[0]?.join(" ") ?? "";
    expect(script).toContain("127.0.0.1:8080");
    expect(script).toContain("127.0.0.1:8443");
    expect(script).toContain("try-restart lando-proxy-http.service");
  });

  test("does not treat 4443 as matching hop target 444", async () => {
    // Given: marked units hopping to 4443/8080.
    const httpUnit = `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:8080\n`;
    const httpsUnit = `${markedUnit}ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:4443\n`;
    const present = Object.fromEntries([
      ...SOCKET_UNIT_PATHS.map((path) => [path, markedUnit]),
      [POLKIT_RULE_PATH, socketProxyPolkitHeader("/lando")],
    ]);
    present["/etc/systemd/system/lando-proxy-http.service"] = httpUnit;
    present["/etc/systemd/system/lando-proxy-https.service"] = httpsUnit;
    const privilege = makePrivilege(ok());
    const installHost = hostFiles({ ...present, [packagedProxyd]: "binary" });

    // When: install is asked to hop to 8080/444.
    const outcome = await Effect.runPromise(
      installSocketProxy({
        user: "lando-dev",
        userDataRoot: "/lando",
        exists: installHost.exists,
        readText: installHost.readText,
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 8080,
        httpsTarget: 444,
      }),
    );

    // Then: 4443 is not a prefix match for 444, so units are rewritten.
    expect(outcome.kind).toBe("installed");
    expect(privilege.calls()).toHaveLength(1);
  });

  test("records elevation refusal without throwing when elevate exits nonzero", async () => {
    // Given: proxyd exists and elevate is refused.
    const privilege = makePrivilege(fail(1, "polkit denied"));

    // When: install runs.
    const outcome = await Effect.runPromise(
      installSocketProxy({
        user: "lando-dev",
        userDataRoot: "/lando",
        exists: hostFiles({ [packagedProxyd]: "binary" }).exists,
        readText: hostFiles().readText,
        processRunner: makeRunner(() => ok()).service,
        privilege: privilege.service,
        httpTarget: 8080,
        httpsTarget: 8443,
      }),
    );

    // Then: the outcome is an elevation failure, not a thrown Effect error.
    expect(outcome.kind).toBe("elevation-refused");
    if (outcome.kind === "elevation-refused") {
      expect(outcome.exitCode).toBe(1);
    }
  });
});

describe("startSockets", () => {
  test("tries unelevated systemctl start before an elevated retry", async () => {
    // Given: unelevated start fails and elevated start succeeds.
    const runner = makeRunner(() => fail(1, "auth"));
    const privilege = makePrivilege(ok());
    const forwards: number[] = [];

    // When: sockets are started.
    const outcome = await Effect.runPromise(
      startSockets({
        userDataRoot: "/lando",
        ...hostFiles({
          ...Object.fromEntries(
            SOCKET_UNIT_PATHS.map((path) => [path, `${socketProxyUnitHeader("/lando")}\n[Unit]\n`]),
          ),
          [POLKIT_RULE_PATH]: `${socketProxyPolkitHeader("/lando")}\npolkit.addRule(function () {});\n`,
        }),
        processRunner: runner.service,
        privilege: privilege.service,
        probeForward: (_host, port) =>
          Effect.sync(() => {
            forwards.push(port);
            return { kind: "success" as const };
          }),
      }),
    );

    // Then: unelevated systemctl ran first, then one elevate, then forward probes.
    expect(outcome.kind).toBe("started");
    const first = runner.calls()[0];
    expect(first?.cmd).toBe("/bin/sh");
    expect(first?.args?.[1]).toContain("flock -x 9");
    expect(first?.args?.[1]).toContain(
      "systemctl start 'lando-proxy-http.socket' 'lando-proxy-https.socket'",
    );
    expect(privilege.calls()).toHaveLength(1);
    expect(privilege.calls()[0]?.join(" ")).toContain("systemctl");
    expect(privilege.calls()[0]?.join(" ")).toContain("start");
    expect(forwards).toEqual([80, 443]);
  });
});

describe("setup classification after helper install", () => {
  test("resolves needs-helper to socket-helper after a successful install attempt", async () => {
    // Given: Linux+systemd, EACCES on 80/443, proxyd present, elevate and forward succeed.
    const files = new Map<string, string>();
    const privilege = makePrivilege(ok());
    const service = makeTraefikRouterService({
      stateStore: makeAckStore([]),
      probeForward: () => Effect.succeed({ kind: "success" }),
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        remove: (path) => Effect.sync(() => void files.delete(path)),
        exists: (path) => Effect.succeed(files.has(path)),
        readDir: () => Effect.succeed([]),
        readText: (path) =>
          files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([{ name: "traefik", state: "running", endpoints: ["http://127.0.0.1:38080"] }]),
      },
      socketProxy: {
        user: "lando-dev",
        userDataRoot: "/lando",
        hasHostSystemd: () => true,
        autoApprove: true,
        exists: (path) => Effect.succeed(path === packagedProxyd),
        readText: () => Effect.fail(new Error("missing")),
        processRunner: makeRunner((input) => (input.cmd === "systemctl" ? ok() : fail(1, "not found")))
          .service,
        privilege: privilege.service,
        classifyOverride: {
          http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
          https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
        },
        probeForward: () => Effect.succeed({ kind: "success" }),
      },
    });

    // When: setup classifies, installs the helper, and re-probes.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: persisted mode is socket-helper on privileged public ports with high-port hops.
    const raw = files.get(acquisitionStateFile({ platform: "linux", globalAppRoot: "/lando/global" }));
    const decoded = Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(raw ?? "null"));
    expect(decoded.mode).toBe("socket-helper");
    expect(decoded.httpPort).toBe(80);
    expect(decoded.httpsPort).toBe(443);
    expect(decoded.bindHttpPort).toBe(DEFAULT_BACKEND_HTTP_TRY_LIST[0]);
    expect(decoded.bindHttpsPort).toBe(DEFAULT_BACKEND_HTTPS_TRY_LIST[0]);
    expect(decoded.helperInstalled).toBe(true);
    expect(decoded.socketsActive).toBe(true);
    const installScript = privilege.calls()[0]?.join(" ") ?? "";
    expect(installScript).toContain("127.0.0.1:38080");
    expect(installScript).toContain("127.0.0.1:38443");
    expect(installScript).not.toContain("127.0.0.1:8080");
  });

  test("records occupied-hop when elevate exits nonzero and does not throw", async () => {
    // Given: preferred ports EACCES and elevation is refused (helper fail continues try-list).
    const files = new Map<string, string>();
    const service = makeTraefikRouterService({
      stateStore: makeAckStore([]),
      probeForward: () => Effect.succeed({ kind: "success" }),
      certificateAuthority: makeTestCertificateAuthority(),
      fileSystem: {
        mkdir: () => Effect.void,
        writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
        remove: (path) => Effect.sync(() => void files.delete(path)),
        exists: (path) => Effect.succeed(files.has(path)),
        readDir: () => Effect.succeed([]),
        readText: (path) =>
          files.has(path) ? Effect.succeed(files.get(path) ?? "") : Effect.fail(new Error(path)),
      },
      paths: { platform: "linux", globalAppRoot: "/lando/global" },
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([{ name: "traefik", state: "running", endpoints: ["http://127.0.0.1:38080"] }]),
      },
      socketProxy: {
        user: "lando-dev",
        userDataRoot: "/lando",
        hasHostSystemd: () => true,
        autoApprove: true,
        exists: (path) => Effect.succeed(path === packagedProxyd),
        readText: () => Effect.fail(new Error("missing")),
        processRunner: makeRunner(() => fail(1, "not found")).service,
        privilege: makePrivilege(fail(1, "refused")).service,
        classifyOverride: {
          http: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
          https: { bind: { kind: "EACCES", code: "EACCES" }, forward: { kind: "failure" } },
        },
      },
    });

    // When: setup attempts helper install.
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));

    // Then: try-list continues to occupied-hop and setup still succeeds.
    const raw = files.get(acquisitionStateFile({ platform: "linux", globalAppRoot: "/lando/global" }));
    const decoded = Schema.decodeUnknownSync(AcquisitionState)(JSON.parse(raw ?? "null"));
    expect(decoded.mode).toBe("occupied-hop");
    expect(decoded.httpPort).toBe(DEFAULT_HTTP_TRY_LIST[1]);
    expect(decoded.httpsPort).toBe(DEFAULT_HTTPS_TRY_LIST[1]);
  });
});
