import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { Effect } from "effect";

import type { PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { AppId, type HostPlatform, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import * as proxyTraefikExports from "../src/index.ts";
import {
  appCertificateFiles,
  certificateDir,
  defaultCertificateFiles,
  defaultCertificateNames,
  defaultTlsFile,
  dynamicConfigDir,
  routeFile,
} from "../src/proxy-paths.ts";
import type { ProxyPaths } from "../src/proxy-types.ts";
import { renderTraefikDefaultTlsConfig, renderTraefikDynamicConfig } from "../src/routing.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";

const TRAEFIK_CONTAINER_CERTIFICATE_DIR = "/etc/traefik/dynamic/certs";

const containerTlsFiles = (certName: string, keyName: string) => ({
  certFile: posix.join(TRAEFIK_CONTAINER_CERTIFICATE_DIR, certName),
  keyFile: posix.join(TRAEFIK_CONTAINER_CERTIFICATE_DIR, keyName),
});

const currentPlatform = (): HostPlatform => {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "linux";
  }
};

const hasProxyTlsDoctorCheck = (
  moduleExports: typeof proxyTraefikExports,
): moduleExports is typeof proxyTraefikExports & {
  readonly proxyTlsDoctorCheck: PluginDoctorCheckContribution;
} => "proxyTlsDoctorCheck" in moduleExports;

const proxyTlsDoctorCheck = hasProxyTlsDoctorCheck(proxyTraefikExports)
  ? proxyTraefikExports.proxyTlsDoctorCheck
  : undefined;

const proxyPaths = (userDataRoot: string): ProxyPaths => ({
  platform: currentPlatform(),
  globalAppRoot: join(userDataRoot, "global"),
});

const runProxyTlsDoctorCheck = (userDataRoot: string | undefined) => {
  if (proxyTlsDoctorCheck === undefined) {
    throw new Error("proxyTlsDoctorCheck is not exported");
  }
  return Effect.runPromise(
    proxyTlsDoctorCheck.run({
      providerId: "lando",
      platform: currentPlatform(),
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    }),
  );
};

const httpApp = AppId.make("http-only-app");
const httpRoutes: ReadonlyArray<RoutePlan> = [
  {
    hostname: "http-only.lndo.site",
    scheme: "http",
    service: ServiceName.make("web"),
    backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
  },
];

describe("proxy-tls plugin doctor check", () => {
  test("warns when HTTPS TLS material is missing", async () => {
    // Given
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-proxy-tls-doctor-missing-"));
    try {
      const paths = proxyPaths(userDataRoot);
      const appFiles = appCertificateFiles(paths, app);
      const defaultNames = defaultCertificateNames("lndo.site");
      await mkdir(dynamicConfigDir(paths), { recursive: true });
      await Promise.all([
        writeFile(
          routeFile(paths, app),
          renderTraefikDynamicConfig(
            httpsRoutes,
            app,
            containerTlsFiles(basename(appFiles.cert), basename(appFiles.key)),
          ),
          "utf8",
        ),
        writeFile(
          defaultTlsFile(paths),
          renderTraefikDefaultTlsConfig(containerTlsFiles(defaultNames.cert, defaultNames.key)),
          "utf8",
        ),
      ]);

      // When
      const reports = await runProxyTlsDoctorCheck(userDataRoot);

      // Then
      expect(reports).toHaveLength(1);
      const report = reports.at(0);
      expect(report?.name).toBe("proxy-tls");
      expect(report?.status).toBe("warn");
      expect(report?.severity).toBe("warn");
      expect(report?.runtimeStatus).toBe("tls-material-missing");
      expect(report?.context).toEqual({
        proxyId: "traefik",
        httpsApps: "1",
        defaultTlsConfig: "present",
        defaultCertificate: "missing",
        appsMissingCertificates: "1",
      });
      expect(report?.solutions).toHaveLength(2);
      expect(report?.solutions.at(0)?.command).toBe("lando setup");
      expect(report?.solutions.at(1)?.description).toContain("active CertificateAuthority plugin");

      const serialized = JSON.stringify(report);
      for (const forbidden of [
        userDataRoot,
        String(app),
        ".crt",
        ".key",
        "-----BEGIN CERTIFICATE-----",
        "-----BEGIN PRIVATE KEY-----",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("passes when HTTPS TLS material exists", async () => {
    // Given
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-proxy-tls-doctor-ready-"));
    try {
      const paths = proxyPaths(userDataRoot);
      const appFiles = appCertificateFiles(paths, app);
      const defaultFiles = defaultCertificateFiles(paths, "lndo.site");
      const defaultNames = defaultCertificateNames("lndo.site");
      await mkdir(certificateDir(paths), { recursive: true });
      await Promise.all([
        writeFile(
          routeFile(paths, app),
          renderTraefikDynamicConfig(
            httpsRoutes,
            app,
            containerTlsFiles(basename(appFiles.cert), basename(appFiles.key)),
          ),
          "utf8",
        ),
        writeFile(
          defaultTlsFile(paths),
          renderTraefikDefaultTlsConfig(containerTlsFiles(defaultNames.cert, defaultNames.key)),
          "utf8",
        ),
        writeFile(appFiles.cert, "-----BEGIN CERTIFICATE-----\napp\n-----END CERTIFICATE-----\n", "utf8"),
        writeFile(appFiles.key, "-----BEGIN PRIVATE KEY-----\napp\n-----END PRIVATE KEY-----\n", "utf8"),
        writeFile(
          defaultFiles.cert,
          "-----BEGIN CERTIFICATE-----\ndefault\n-----END CERTIFICATE-----\n",
          "utf8",
        ),
        writeFile(
          defaultFiles.key,
          "-----BEGIN PRIVATE KEY-----\ndefault\n-----END PRIVATE KEY-----\n",
          "utf8",
        ),
      ]);

      // When
      const reports = await runProxyTlsDoctorCheck(userDataRoot);

      // Then
      expect(reports).toHaveLength(1);
      const report = reports.at(0);
      expect(report?.name).toBe("proxy-tls");
      expect(report?.status).toBe("pass");
      expect(report?.severity).toBe("info");
      expect(report?.runtimeStatus).toBe("tls-ready");
      expect(report?.context).toEqual({
        proxyId: "traefik",
        httpsApps: "1",
        defaultTlsConfig: "present",
        defaultCertificate: "present",
        appsMissingCertificates: "0",
      });
      expect(report?.solutions).toEqual([]);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("stays silent for HTTP-only or absent root", async () => {
    // Given
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-proxy-tls-doctor-silent-"));
    try {
      const paths = proxyPaths(userDataRoot);
      await mkdir(dynamicConfigDir(paths), { recursive: true });
      await writeFile(routeFile(paths, httpApp), renderTraefikDynamicConfig(httpRoutes, httpApp), "utf8");

      // When
      const reports = await Promise.all([
        runProxyTlsDoctorCheck(userDataRoot),
        runProxyTlsDoctorCheck(join(userDataRoot, "absent")),
        runProxyTlsDoctorCheck(undefined),
      ]);

      // Then
      expect(reports).toEqual([[], [], []]);
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });
});
