import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import type { HostPlatform } from "@lando/sdk/schema";

import { DESIRED_HTTPS_PORT, DESIRED_HTTP_PORT } from "../src/port-acquisition.ts";
import {
  type PreferredHostPortReaders,
  type PreferredHostPortSnapshot,
  makePreferredHostPortsCheck,
} from "../src/preferred-host-ports.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";

const LOOPBACK_HOST = "127.0.0.1" as const;
const OCCUPIED_HOP = { mode: "occupied-hop", httpPort: 8080, httpsPort: 8443 } as const;

const snapshot = (
  port: number,
  fields: Omit<PreferredHostPortSnapshot, "port">,
): PreferredHostPortSnapshot => ({
  port,
  ...fields,
});

const free = (port: number): PreferredHostPortSnapshot => snapshot(port, { listening: false });

const readersFor = (
  ports: Readonly<Record<number, PreferredHostPortSnapshot>>,
): PreferredHostPortReaders => ({
  readPort: async (port) => ports[port] ?? free(port),
});

const runCheck = (
  readers: PreferredHostPortReaders,
  platform: HostPlatform = "linux",
  userDataRoot?: string,
) =>
  Effect.runPromise(
    makePreferredHostPortsCheck(readers).run({
      providerId: "lando",
      platform,
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

const withAcquisitionFile = (state: {
  readonly mode: string;
  readonly httpPort?: number;
  readonly httpsPort?: number;
  readonly bindHttpPort?: number;
  readonly bindHttpsPort?: number;
}): { readonly userDataRoot: string; readonly cleanup: () => void } => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-preferred-acq-"));
  const paths = makeLandoPaths({ userDataRoot, platform: "linux" });
  const stateFile = acquisitionStateFile({
    platform: paths.platform,
    globalAppRoot: paths.globalAppRoot,
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  return {
    userDataRoot,
    cleanup: () => rmSync(userDataRoot, { recursive: true, force: true }),
  };
};

const joinedSolutions = (
  solutions: ReadonlyArray<{ readonly description: string; readonly command?: string | undefined }>,
) => solutions.map((solution) => `${solution.description} ${solution.command ?? ""}`).join(" ");

describe("makePreferredHostPortsCheck", () => {
  test("warns when DDEV occupies preferred HTTP", async () => {
    // Given: 80 is listening as ddev-router and acquisition is occupied-hop 8080/8443.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "ddev-router" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: one warn names ddev and offers ddev poweroff, never fail.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).not.toBe("fail");
      expect(reports[0]).toMatchObject({
        name: "preferred-host-ports",
        status: "warn",
        severity: "warn",
        runtimeStatus: "preferred-port-occupied",
        runtime: { running: false },
      });
      expect(reports[0]?.context.host).toBe(LOOPBACK_HOST);
      expect(reports[0]?.context.holder).toBe("ddev");
      expect(reports[0]?.context.ports).toBe(String(DESIRED_HTTP_PORT));
      expect(joinedSolutions(reports[0]?.solutions ?? [])).toContain("ddev poweroff");
    } finally {
      acquisition.cleanup();
    }
  });

  test("warns when Apache occupies preferred HTTP", async () => {
    // Given: 80 is listening as httpd and acquisition is occupied-hop 8080/8443.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "httpd" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: one warn classifies apache and remediates Apache.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.context.holder).toBe("apache");
      expect(joinedSolutions(reports[0]?.solutions ?? [])).toContain("Apache");
    } finally {
      acquisition.cleanup();
    }
  });

  test("warns when an unknown process occupies preferred HTTP", async () => {
    // Given: 80 is listening as python pid 4242 and acquisition is occupied-hop.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, {
        listening: true,
        comm: "python",
        pid: 4242,
      }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: one warn names python, 4242, and router.httpPort.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.context.holder).toBe("unknown");
      expect(reports[0]?.context.comm).toBe("python");
      expect(reports[0]?.context.pid).toBe("4242");
      const remediation = joinedSolutions(reports[0]?.solutions ?? []);
      expect(remediation).toContain("python");
      expect(remediation).toContain("4242");
      expect(remediation).toContain("router.httpPort");
    } finally {
      acquisition.cleanup();
    }
  });

  test("skips when this instance claims preferred ports as direct", async () => {
    // Given: acquisition claims 80/443 in direct mode even though nginx is listening.
    const acquisition = withAcquisitionFile({
      mode: "direct",
      httpPort: DESIRED_HTTP_PORT,
      httpsPort: DESIRED_HTTPS_PORT,
    });
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "nginx" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: Lando-owned occupancy is skipped.
      expect(reports).toEqual([]);
    } finally {
      acquisition.cleanup();
    }
  });

  test("skips when this instance uses socket-helper on preferred ports", async () => {
    // Given: socket-helper advertises 80/443 and 80 is listening.
    const acquisition = withAcquisitionFile({
      mode: "socket-helper",
      httpPort: DESIRED_HTTP_PORT,
      httpsPort: DESIRED_HTTPS_PORT,
      bindHttpPort: 8080,
      bindHttpsPort: 8443,
    });
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "nginx" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: socket-helper occupancy is skipped.
      expect(reports).toEqual([]);
    } finally {
      acquisition.cleanup();
    }
  });

  test("skips leftover-rootlessport occupancy", async () => {
    // Given: 80 is leftover-rootlessport and acquisition is occupied-hop 8080/8443.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, {
        listening: true,
        comm: "rootlessport",
        kind: "leftover-rootlessport",
      }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: leftover-rootlessport is not this check.
      expect(reports).toEqual([]);
    } finally {
      acquisition.cleanup();
    }
  });

  test("collapses occupied HTTP and TLS into one report using HTTP holder", async () => {
    // Given: nginx on 80 and caddy on 443 with occupied-hop acquisition.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "nginx" }),
      [DESIRED_HTTPS_PORT]: snapshot(DESIRED_HTTPS_PORT, { listening: true, comm: "caddy" }),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: one report lists 80,443 and remediates nginx.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.context.ports).toBe(`${DESIRED_HTTP_PORT},${DESIRED_HTTPS_PORT}`);
      expect(reports[0]?.context.holder).toBe("nginx");
      expect(joinedSolutions(reports[0]?.solutions ?? [])).toContain("nginx");
    } finally {
      acquisition.cleanup();
    }
  });

  test("returns no reports when preferred ports are free", async () => {
    // Given: neither 80 nor 443 is listening.
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: free(DESIRED_HTTP_PORT),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers);

    // Then: occupancy warning is absent.
    expect(reports).toEqual([]);
  });

  test("exposes an always-relevant preferred-host-ports contribution", () => {
    // Given: preferred-port readers for contribution metadata.
    const readers = readersFor({});

    // When: the doctor contribution is constructed.
    const check = makePreferredHostPortsCheck(readers);

    // Then: the contribution id is fixed and relevant is unset.
    expect(check.id).toBe("preferred-host-ports");
    expect(check.relevant).toBeUndefined();
  });

  test("still warns on darwin when preferred HTTP is occupied", async () => {
    // Given: unknown listener on 80 with occupied-hop acquisition on darwin.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "python" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs on darwin.
      const reports = await runCheck(readers, "darwin", acquisition.userDataRoot);

      // Then: platform does not suppress an injected occupancy.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.name).toBe("preferred-host-ports");
    } finally {
      acquisition.cleanup();
    }
  });

  test("warns with IIS solutions when w3wp occupies preferred HTTP on win32", async () => {
    // Given: w3wp listening on 80 with occupied-hop acquisition on win32.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "w3wp" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs on win32.
      const reports = await runCheck(readers, "win32", acquisition.userDataRoot);

      // Then: one warn classifies iis.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.context.holder).toBe("iis");
      expect(joinedSolutions(reports[0]?.solutions ?? [])).toContain("IIS");
    } finally {
      acquisition.cleanup();
    }
  });

  test("warns when acquisition is missing and DDEV occupies preferred HTTP", async () => {
    // Given: no userDataRoot and 80 listening as ddev-router.
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, { listening: true, comm: "ddev-router" }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    // When: the doctor contribution runs without acquisition.
    const reports = await runCheck(readers);

    // Then: missing acquisition claims nothing so occupancy still warns.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe("warn");
    expect(reports[0]?.context.holder).toBe("ddev");
  });

  test("classifies Traefik with ddev cmdline as ddev occupancy", async () => {
    // Given: traefik on 80 whose cmdline mentions ddev, occupied-hop acquisition.
    const acquisition = withAcquisitionFile(OCCUPIED_HOP);
    const readers = readersFor({
      [DESIRED_HTTP_PORT]: snapshot(DESIRED_HTTP_PORT, {
        listening: true,
        comm: "traefik",
        cmdline: "/usr/local/bin/traefik --config=/var/lib/ddev/traefik",
      }),
      [DESIRED_HTTPS_PORT]: free(DESIRED_HTTPS_PORT),
    });

    try {
      // When: the doctor contribution runs.
      const reports = await runCheck(readers, "linux", acquisition.userDataRoot);

      // Then: holder is ddev, not leftover skip.
      expect(reports).toHaveLength(1);
      expect(reports[0]?.status).toBe("warn");
      expect(reports[0]?.context.holder).toBe("ddev");
    } finally {
      acquisition.cleanup();
    }
  });
});
