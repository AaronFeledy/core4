import { describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { basename } from "node:path";

import {
  chmodMakesUnreadable,
  containerTlsFiles,
  createProxyTlsFixture,
  removeProxyTlsFixture,
  runProxyTlsDoctorCheck,
  symlinkAppTls,
  writeAppTls,
  writeDefaultTls,
  writeHttpsRoute,
  writeNamedTls,
} from "./proxy-doctor-tls-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";

const expectTlsWarning = (
  reports: Awaited<ReturnType<typeof runProxyTlsDoctorCheck>>,
  expected: { readonly defaultCertificate: "present" | "missing"; readonly appsMissing: string },
): void => {
  expect(reports).toHaveLength(1);
  const report = reports.at(0);
  expect(report?.status).toBe("warn");
  expect(report?.runtimeStatus).toBe("tls-material-missing");
  expect(report?.context).toEqual({
    proxyId: "traefik",
    httpsApps: "1",
    defaultTlsConfig: "present",
    defaultCertificate: expected.defaultCertificate,
    appsMissingCertificates: expected.appsMissing,
  });
};

describe("proxy-tls persisted material readiness", () => {
  test.skipIf(!chmodMakesUnreadable)(
    "warns when default certificate and app key are unreadable",
    async () => {
      // Given
      const fixture = await createProxyTlsFixture("unreadable");
      try {
        const appFiles = await writeAppTls(fixture, app);
        const defaultFiles = await writeDefaultTls(fixture);
        await writeHttpsRoute(fixture, {
          app,
          routes: httpsRoutes,
          tlsFiles: containerTlsFiles(basename(appFiles.cert), basename(appFiles.key)),
        });
        await Promise.all([chmod(defaultFiles.cert, 0), chmod(appFiles.key, 0)]);

        // When
        const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

        // Then
        expectTlsWarning(reports, { defaultCertificate: "missing", appsMissing: "1" });
      } finally {
        await removeProxyTlsFixture(fixture);
      }
    },
  );

  test("warns when an HTTPS route omits persisted TLS files", async () => {
    // Given
    const fixture = await createProxyTlsFixture("omitted-pair");
    try {
      await writeDefaultTls(fixture);
      await writeAppTls(fixture, app);
      await writeHttpsRoute(fixture, { app, routes: httpsRoutes });

      // When
      const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

      // Then
      expectTlsWarning(reports, { defaultCertificate: "present", appsMissing: "1" });
    } finally {
      await removeProxyTlsFixture(fixture);
    }
  });

  test("passes with custom persisted certificate basenames without leaking them", async () => {
    // Given
    const fixture = await createProxyTlsFixture("custom-pair");
    try {
      await writeDefaultTls(fixture);
      const names = { cert: "custom-app-certificate.pem", key: "custom-app-private-key.pem" };
      const tlsFiles = await writeNamedTls(fixture, names);
      await writeHttpsRoute(fixture, { app, routes: httpsRoutes, tlsFiles });

      // When
      const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

      // Then
      expect(reports).toHaveLength(1);
      expect(reports.at(0)?.context).toEqual({
        proxyId: "traefik",
        httpsApps: "1",
        defaultTlsConfig: "present",
        defaultCertificate: "present",
        appsMissingCertificates: "0",
      });
      expect(reports.at(0)?.status).toBe("pass");
      const serialized = JSON.stringify(reports);
      expect(serialized).not.toContain(names.cert);
      expect(serialized).not.toContain(names.key);
    } finally {
      await removeProxyTlsFixture(fixture);
    }
  });

  test("warns when persisted app TLS material is symlinked", async () => {
    // Given
    const fixture = await createProxyTlsFixture("symlinked-pair");
    try {
      await writeDefaultTls(fixture);
      const tlsFiles = await symlinkAppTls(fixture, app);
      await writeHttpsRoute(fixture, { app, routes: httpsRoutes, tlsFiles });

      // When
      const reports = await runProxyTlsDoctorCheck(fixture.userDataRoot);

      // Then
      expectTlsWarning(reports, { defaultCertificate: "present", appsMissing: "1" });
    } finally {
      await removeProxyTlsFixture(fixture);
    }
  });
});
