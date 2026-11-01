import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeManagedRuntimeContainersConf } from "../src/runtime-config.ts";

const MANAGED_LOOPBACK_IPS = ["127.0.0.1", "::1"] as const;
const MANAGED_POLICY = `{
  "default": [
    {
      "type": "insecureAcceptAnything"
    }
  ],
  "transports": {
    "docker-daemon": {
      "": [
        {
          "type": "insecureAcceptAnything"
        }
      ]
    }
  }
}
`;

interface ManagedContainersConf {
  readonly containers?: {
    readonly cgroups?: string;
    readonly log_driver?: string;
    readonly init_path?: string;
    readonly init?: boolean;
  };
  readonly engine?: {
    readonly cgroup_manager?: string;
    readonly events_logger?: string;
    readonly helper_binaries_dir?: ReadonlyArray<string>;
    readonly conmon_path?: ReadonlyArray<string>;
    readonly runtime?: string;
    readonly runtimes?: { readonly crun?: ReadonlyArray<string> };
  };
  readonly network?: { readonly default_host_ips?: ReadonlyArray<string> };
}

interface ManagedRegistriesConf {
  readonly "unqualified-search-registries"?: ReadonlyArray<string>;
}

interface ManagedPolicy {
  readonly default?: ReadonlyArray<{ readonly type?: string }>;
  readonly transports?: {
    readonly "docker-daemon"?: Record<string, ReadonlyArray<{ readonly type?: string }>>;
  };
}

const writeAndParse = async (): Promise<{
  readonly runtimeBinDir: string;
  readonly body: string;
  readonly registriesBody: string;
  readonly policyBody: string;
  readonly parsed: ManagedContainersConf;
  readonly registriesParsed: ManagedRegistriesConf;
  readonly policyParsed: ManagedPolicy;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-"));
  const runtimeBinDir = join(root, "runtime", "bin");
  const runtimeConfigDir = join(root, "runtime", "config");
  try {
    await Effect.runPromise(
      writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir, useSystemdRunShim: false }),
    );
    const body = await readFile(join(runtimeConfigDir, "containers.conf"), "utf8");
    const registriesBody = await readFile(join(runtimeConfigDir, "registries.conf"), "utf8");
    const policyBody = await readFile(join(runtimeConfigDir, "containers", "policy.json"), "utf8");
    return {
      runtimeBinDir,
      body,
      registriesBody,
      policyBody,
      parsed: Bun.TOML.parse(body) as ManagedContainersConf,
      registriesParsed: Bun.TOML.parse(registriesBody) as ManagedRegistriesConf,
      policyParsed: JSON.parse(policyBody) as ManagedPolicy,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const withRuntimeConfigRoot = async (
  run: (paths: {
    readonly root: string;
    readonly runtimeBinDir: string;
    readonly runtimeConfigDir: string;
    readonly containersConf: string;
    readonly registriesConf: string;
    readonly policyJson: string;
    readonly shim: string;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-cond-"));
  const runtimeBinDir = join(root, "runtime", "bin");
  const runtimeConfigDir = join(root, "runtime", "config");
  try {
    await run({
      root,
      runtimeBinDir,
      runtimeConfigDir,
      containersConf: join(runtimeConfigDir, "containers.conf"),
      registriesConf: join(runtimeConfigDir, "registries.conf"),
      policyJson: join(runtimeConfigDir, "containers", "policy.json"),
      shim: join(runtimeBinDir, "systemd-run"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeOnce = (runtimeBinDir: string, runtimeConfigDir: string, useSystemdRunShim = false) =>
  Effect.runPromise(
    writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir, useSystemdRunShim }),
  );

describe("writeManagedRuntimeContainersConf", () => {
  test("pins native init to the private binary without globally enabling init", async () => {
    const { runtimeBinDir, parsed } = await writeAndParse();
    expect(parsed.containers?.init_path).toBe(join(runtimeBinDir, "catatonit"));
    expect(parsed.containers?.init).toBeUndefined();
    expect(parsed.engine).not.toHaveProperty("init_path");
  });
  test("writes helper_binaries_dir pointing at runtimeBinDir", async () => {
    const { runtimeBinDir, body } = await writeAndParse();
    expect(body).toContain(`helper_binaries_dir = ["${runtimeBinDir}"]`);
  });

  test("emits parseable TOML with loopback default_host_ips coexisting with helper_binaries_dir", async () => {
    const { runtimeBinDir, parsed } = await writeAndParse();
    expect(parsed.engine?.helper_binaries_dir).toEqual([runtimeBinDir]);
    expect(parsed.network?.default_host_ips).toEqual(MANAGED_LOOPBACK_IPS);
  });

  test("pins the bundled OCI runtime and conmon so host binaries are never used", async () => {
    const { runtimeBinDir, parsed } = await writeAndParse();
    expect(parsed.engine?.runtime).toBe("crun");
    expect(parsed.engine?.runtimes?.crun).toEqual([join(runtimeBinDir, "crun")]);
    expect(parsed.engine?.conmon_path).toEqual([join(runtimeBinDir, "conmon")]);
    expect(parsed.containers?.log_driver).toBe("k8s-file");
    expect(parsed.containers?.cgroups).toBe("no-conmon");
    expect(parsed.engine?.cgroup_manager).toBe("cgroupfs");
    expect(parsed.engine?.events_logger).toBe("file");
  });

  test("binds default published ports to loopback only for the managed runtime", async () => {
    const { parsed } = await writeAndParse();
    const hostIps = parsed.network?.default_host_ips ?? [];
    for (const ip of hostIps) {
      expect(MANAGED_LOOPBACK_IPS as readonly string[]).toContain(ip);
    }
    expect(hostIps).toContain(MANAGED_LOOPBACK_IPS[0]);
    expect(hostIps).toContain(MANAGED_LOOPBACK_IPS[1]);
  });

  test("does not set an invalid pasta network_backend on Podman 6", async () => {
    const { body, parsed } = await writeAndParse();
    expect(body).not.toContain("network_backend");
    expect(body).not.toContain("pasta");
    expect(
      (parsed.network as { readonly network_backend?: string } | undefined)?.network_backend,
    ).toBeUndefined();
  });

  test("never emits a LAN wildcard default for the managed runtime", async () => {
    const { body, parsed } = await writeAndParse();
    const hostIps = parsed.network?.default_host_ips ?? [];
    expect(hostIps.length).toBeGreaterThan(0);
    expect(hostIps).not.toContain("0.0.0.0");
    expect(hostIps).not.toContain("::");
    expect(body).not.toContain("0.0.0.0");
    expect(body).not.toContain("default_host_ips = []");
  });

  test("writes a hermetic v2 registries.conf for the managed runtime", async () => {
    const { registriesBody, registriesParsed } = await writeAndParse();
    expect(registriesBody).toBe('unqualified-search-registries = ["docker.io"]\n');
    expect(registriesParsed["unqualified-search-registries"]).toEqual(["docker.io"]);
  });

  test("writes the permissive signature policy in the managed containers config directory", async () => {
    const { policyBody, policyParsed } = await writeAndParse();
    expect(policyBody).toBe(MANAGED_POLICY);
    expect(policyParsed.default?.[0]?.type).toBe("insecureAcceptAnything");
    expect(policyParsed.transports?.["docker-daemon"]?.[""]?.[0]?.type).toBe("insecureAcceptAnything");
  });

  test("writes a systemd-run shim when the host has no user systemd session", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-shim-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const runtimeConfigDir = join(root, "runtime", "config");
    try {
      await Effect.runPromise(
        writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir, useSystemdRunShim: true }),
      );
      const shim = join(runtimeBinDir, "systemd-run");
      await access(shim, constants.X_OK);
      const result = await Bun.$`${shim} -q --scope --user /bin/echo aardvark-ok`.text();
      expect(result).toContain("aardvark-ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a leftover systemd-run shim when a user systemd session exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-shim-remove-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const runtimeConfigDir = join(root, "runtime", "config");
    try {
      await Effect.runPromise(
        writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir, useSystemdRunShim: true }),
      );
      await Effect.runPromise(
        writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir, useSystemdRunShim: false }),
      );
      const shim = join(runtimeBinDir, "systemd-run");
      await expect(access(shim, constants.F_OK)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips writes when content and mode already match so mtime stays put", async () => {
    await withRuntimeConfigRoot(async (paths) => {
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, true);
      const past = new Date(Date.now() - 120_000);
      for (const path of [paths.containersConf, paths.registriesConf, paths.policyJson, paths.shim]) {
        await utimes(path, past, past);
      }
      const before = {
        containers: (await stat(paths.containersConf)).mtimeMs,
        registries: (await stat(paths.registriesConf)).mtimeMs,
        policy: (await stat(paths.policyJson)).mtimeMs,
        shim: (await stat(paths.shim)).mtimeMs,
      };
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, true);
      expect((await stat(paths.containersConf)).mtimeMs).toBe(before.containers);
      expect((await stat(paths.registriesConf)).mtimeMs).toBe(before.registries);
      expect((await stat(paths.policyJson)).mtimeMs).toBe(before.policy);
      expect((await stat(paths.shim)).mtimeMs).toBe(before.shim);
    });
  });

  test("repairs mode-only drift without rewriting matching content", async () => {
    await withRuntimeConfigRoot(async (paths) => {
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, true);
      const containersBody = await readFile(paths.containersConf, "utf8");
      const registriesBody = await readFile(paths.registriesConf, "utf8");
      const policyBody = await readFile(paths.policyJson, "utf8");
      const shimBody = await readFile(paths.shim, "utf8");
      await chmod(paths.containersConf, 0o644);
      await chmod(paths.registriesConf, 0o4600);
      await chmod(paths.policyJson, 0o644);
      await chmod(paths.shim, 0o644);
      const past = new Date(Date.now() - 120_000);
      for (const path of [paths.containersConf, paths.registriesConf, paths.policyJson, paths.shim]) {
        await utimes(path, past, past);
      }
      const before = {
        containers: (await stat(paths.containersConf)).mtimeMs,
        registries: (await stat(paths.registriesConf)).mtimeMs,
        policy: (await stat(paths.policyJson)).mtimeMs,
        shim: (await stat(paths.shim)).mtimeMs,
      };
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, true);
      expect((await stat(paths.containersConf)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.registriesConf)).mode & 0o7777).toBe(0o600);
      expect((await stat(paths.policyJson)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.shim)).mode & 0o777).toBe(0o755);
      expect(await readFile(paths.containersConf, "utf8")).toBe(containersBody);
      expect(await readFile(paths.registriesConf, "utf8")).toBe(registriesBody);
      expect(await readFile(paths.policyJson, "utf8")).toBe(policyBody);
      expect(await readFile(paths.shim, "utf8")).toBe(shimBody);
      // chmod-only repair must not bump mtime.
      expect((await stat(paths.containersConf)).mtimeMs).toBe(before.containers);
      expect((await stat(paths.registriesConf)).mtimeMs).toBe(before.registries);
      expect((await stat(paths.policyJson)).mtimeMs).toBe(before.policy);
      expect((await stat(paths.shim)).mtimeMs).toBe(before.shim);
    });
  });

  test("rewrites when content differs even if mode already matches", async () => {
    await withRuntimeConfigRoot(async (paths) => {
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, false);
      await writeFile(paths.containersConf, "stale-containers\n", { mode: 0o600 });
      await writeFile(paths.registriesConf, "stale-registries\n", { mode: 0o600 });
      await writeFile(paths.policyJson, '{"stale":true}\n', { mode: 0o600 });
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, false);
      const body = await readFile(paths.containersConf, "utf8");
      expect(body).toContain("helper_binaries_dir");
      expect(body).not.toContain("stale-containers");
      expect(await readFile(paths.registriesConf, "utf8")).toBe(
        'unqualified-search-registries = ["docker.io"]\n',
      );
      expect(await readFile(paths.policyJson, "utf8")).toBe(MANAGED_POLICY);
      expect((await stat(paths.containersConf)).mode & 0o777).toBe(0o600);
    });
  });

  test("replaces a managed config symlink without writing its foreign target", async () => {
    await withRuntimeConfigRoot(async (paths) => {
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, false);
      const foreign = `${paths.registriesConf}.foreign`;
      await writeFile(foreign, "foreign-content");
      await rm(paths.registriesConf);
      await symlink(foreign, paths.registriesConf);
      await writeOnce(paths.runtimeBinDir, paths.runtimeConfigDir, false);
      expect(await readFile(foreign, "utf8")).toBe("foreign-content");
      expect((await lstat(paths.registriesConf)).isFile()).toBe(true);
    });
  });
});
