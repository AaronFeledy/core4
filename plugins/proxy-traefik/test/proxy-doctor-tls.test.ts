import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { AppId, type RoutePlan, ServiceName } from "@lando/sdk/schema";

import {
  containerTlsFiles,
  createProxyTlsFixture,
  removeProxyTlsFixture,
  runProxyTlsDoctorCheck,
  writeAppTls,
  writeDefaultTls,
  writeHttpsRoute,
} from "./proxy-doctor-tls-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";

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
    const fixture = await createProxyTlsFixture("missing");
    try {
      const [appFiles, defaultFiles] = await Promise.all([
        writeAppTls(fixture, app),
        writeDefaultTls(fixture),
      ]);
      await writeHttpsRoute(fixture, {
        app,
        routes: httpsRoutes,
        tlsFiles: containerTlsFiles(basename(appFiles.cert), basename(appFiles.key)),
      });
      await Promise.all(
        [appFiles.cert, appFiles.key, defaultFiles.cert, defaultFiles.key].map((path) => rm(path)),
      );

      // When
      const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

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
        fixture.userDataRoot,
        String(app),
        ".crt",
        ".key",
        "-----BEGIN CERTIFICATE-----",
        "-----BEGIN PRIVATE KEY-----",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      await removeProxyTlsFixture(fixture);
    }
  });

  test("passes when HTTPS TLS material exists", async () => {
    // Given
    const fixture = await createProxyTlsFixture("ready");
    try {
      const appFiles = await writeAppTls(fixture, app);
      await writeDefaultTls(fixture);
      await writeHttpsRoute(fixture, {
        app,
        routes: httpsRoutes,
        tlsFiles: containerTlsFiles(basename(appFiles.cert), basename(appFiles.key)),
      });

      // When
      const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

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
      await removeProxyTlsFixture(fixture);
    }
  });

  test("stays silent for HTTP-only or absent root", async () => {
    // Given
    const fixture = await createProxyTlsFixture("silent");
    try {
      await writeHttpsRoute(fixture, { app: httpApp, routes: httpRoutes });

      // When
      const reports = await Promise.all([
        runProxyTlsDoctorCheck(fixture.userDataRoot),
        runProxyTlsDoctorCheck(join(fixture.userDataRoot, "absent")),
        runProxyTlsDoctorCheck(undefined),
      ]);

      // Then
      expect(reports).toEqual([[], [], []]);
    } finally {
      await removeProxyTlsFixture(fixture);
    }
  });
});
