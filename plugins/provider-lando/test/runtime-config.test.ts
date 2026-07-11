import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { writeManagedRuntimeContainersConf } from "../src/runtime-config.ts";

const MANAGED_LOOPBACK_IPS = ["127.0.0.1", "::1"] as const;

interface ManagedContainersConf {
  readonly engine?: { readonly helper_binaries_dir?: ReadonlyArray<string> };
  readonly network?: { readonly default_host_ips?: ReadonlyArray<string> };
}

interface ManagedRegistriesConf {
  readonly "unqualified-search-registries"?: ReadonlyArray<string>;
}

const writeAndParse = async (): Promise<{
  readonly runtimeBinDir: string;
  readonly body: string;
  readonly registriesBody: string;
  readonly parsed: ManagedContainersConf;
  readonly registriesParsed: ManagedRegistriesConf;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-runtime-config-"));
  const runtimeBinDir = join(root, "runtime", "bin");
  const runtimeConfigDir = join(root, "runtime", "config");
  try {
    await Effect.runPromise(writeManagedRuntimeContainersConf({ runtimeBinDir, runtimeConfigDir }));
    const body = await readFile(join(runtimeConfigDir, "containers.conf"), "utf8");
    const registriesBody = await readFile(join(runtimeConfigDir, "registries.conf"), "utf8");
    return {
      runtimeBinDir,
      body,
      registriesBody,
      parsed: Bun.TOML.parse(body) as ManagedContainersConf,
      registriesParsed: Bun.TOML.parse(registriesBody) as ManagedRegistriesConf,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("writeManagedRuntimeContainersConf", () => {
  test("writes helper_binaries_dir pointing at runtimeBinDir", async () => {
    const { runtimeBinDir, body } = await writeAndParse();
    expect(body).toContain(`helper_binaries_dir = ["${runtimeBinDir}"]`);
  });

  test("emits parseable TOML with loopback default_host_ips coexisting with helper_binaries_dir", async () => {
    const { runtimeBinDir, parsed } = await writeAndParse();
    expect(parsed.engine?.helper_binaries_dir).toEqual([runtimeBinDir]);
    expect(parsed.network?.default_host_ips).toEqual(MANAGED_LOOPBACK_IPS);
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
});
