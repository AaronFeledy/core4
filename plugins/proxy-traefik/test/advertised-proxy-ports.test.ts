import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import type { HostPlatform } from "@lando/sdk/schema";

import {
  type AdvertisedPortReaders,
  type AdvertisedPortSnapshot,
  makeAdvertisedProxyPortsCheck,
} from "../src/advertised-proxy-ports.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";

const idle = (port: number): AdvertisedPortSnapshot => ({ port, listening: false, httpOk: false });
const openDead = (port: number): AdvertisedPortSnapshot => ({ port, listening: true, httpOk: false });
const healthy = (port: number): AdvertisedPortSnapshot => ({ port, listening: true, httpOk: true });

const readersFor = (ports: Readonly<Record<number, AdvertisedPortSnapshot>>): AdvertisedPortReaders => ({
  readPort: async (port) => ports[port] ?? idle(port),
});

const runCheck = (
  readers: AdvertisedPortReaders,
  platform: HostPlatform = "linux",
  ports?: { readonly httpPort: number; readonly httpsPort: number },
  userDataRoot?: string,
) =>
  Effect.runPromise(
    makeAdvertisedProxyPortsCheck(readers, ports).run({
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
  readonly socketsActive?: boolean;
}): { readonly userDataRoot: string; readonly cleanup: () => void } => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-advertised-acq-"));
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

describe("makeAdvertisedProxyPortsCheck", () => {
  test("warns when advertised HTTP is listening but GET fails", async () => {
    // Given: port 80 accepts TCP but does not answer HTTP.
    const readers = readersFor({ 80: openDead(80), 443: healthy(443) });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers, "linux", { httpPort: 80, httpsPort: 443 });

    // Then: one warn names port 80 and offers restart.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      name: "proxy-advertised-ports",
      status: "warn",
      runtimeStatus: "advertised-port-unhealthy",
    });
    expect(reports[0]?.context.ports).toBe("80");
    expect(reports[0]?.solutions.some((solution) => solution.command === "lando global:restart")).toBe(true);
  });

  test("returns no reports when advertised ports answer HTTP", async () => {
    // Given: 80 and 443 both answer.
    const readers = readersFor({ 80: healthy(80), 443: healthy(443) });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers, "linux", { httpPort: 80, httpsPort: 443 });

    // Then: no mismatch warning.
    expect(reports).toEqual([]);
  });

  test("returns no reports when advertised ports are not listening", async () => {
    // Given: nothing is bound on the advertised pair.
    const readers = readersFor({ 80: idle(80), 443: idle(443) });

    // When: the doctor contribution runs.
    const reports = await runCheck(readers, "linux", { httpPort: 80, httpsPort: 443 });

    // Then: leftover/occupancy checks own that case.
    expect(reports).toEqual([]);
  });

  test("probes 80/443 for socket-helper acquisition state", async () => {
    // Given: acquisition is socket-helper; 80 is open but dead.
    const acq = withAcquisitionFile({ mode: "socket-helper", httpPort: 80, httpsPort: 443 });
    const readers = readersFor({ 80: openDead(80), 443: idle(443) });
    try {
      // When: the check reads acquisition instead of an override pair.
      const reports = await runCheck(readers, "linux", undefined, acq.userDataRoot);
      // Then: it probes 80, not a fallback authority.
      expect(reports[0]?.context.ports).toBe("80");
    } finally {
      acq.cleanup();
    }
  });
});
