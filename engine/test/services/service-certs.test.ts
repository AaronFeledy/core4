import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Result } from "effect";

import { FilePermissionError, LandofileValidationError } from "@lando/sdk/errors";

import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths";
import { resolveCertsFeature } from "../../src/services/service-certs";

const planned = {
  certificateAuthority: Result.succeed({ id: "test" }),
  leafLocation: { certsDir: "/tmp/lando-certs", ownerKey: "owner" },
} as const;

test("reads both custom certificate files and rejects an unreadable key", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-service-certs-read-"));
  const certPath = join(appRoot, "certs", "custom.crt");
  const keyPath = join(appRoot, "certs", "custom.key");
  const reads: string[] = [];

  try {
    await mkdir(join(appRoot, "certs"), { recursive: true });
    await writeFile(certPath, "cert\n", "utf-8");
    await writeFile(keyPath, "key\n", "utf-8");

    // Given: a regular custom cert/key pair whose key cannot be read.
    const fileSystem = {
      stat: () => Effect.succeed({ size: 1, mtimeMs: 0, isFile: true, isDirectory: false }),
      readFile: (path: string) => {
        reads.push(path);
        return path === keyPath
          ? Effect.fail(new FilePermissionError({ message: "permission denied", path }))
          : Effect.succeed("cert");
      },
    };

    // When: custom certificate resolution validates both authored files.
    const failure = await Effect.runPromise(
      Effect.flip(
        resolveCertsFeature({
          appName: "certs-read",
          appRoot,
          serviceName: "web",
          certs: { cert: "./certs/custom.crt", key: "./certs/custom.key" },
          hostnames: [],
          routes: [],
          ...planned,
          fileSystem,
        }),
      ),
    );

    // Then: both files were read and the existing authored-path remediation is returned.
    expect(reads).toEqual([certPath, keyPath]);
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(failure.cause).toMatchObject({ _tag: "FilePermissionError", path: keyPath });
    expect(String(failure)).toContain("path ./certs/custom.key could not be read");
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

test("maps route hostnames to certificate SANs and skips uncoverable HTTP wildcards", async () => {
  // Given: routes mix a concrete host, a leftmost partial wildcard, and an HTTP-only deep wildcard.
  const appName = "demo";

  // When
  const result = await Effect.runPromise(
    resolveCertsFeature({
      appName,
      appRoot: "/tmp/certs-sans",
      serviceName: "web",
      certs: true,
      hostnames: [],
      routes: [
        { hostname: "app.lndo.site", filters: [] },
        { hostname: "*-app.lndo.site", filters: [] },
        { hostname: "wild.*.lndo.site", scheme: "http", filters: [] },
      ],
      ...planned,
    }),
  );

  // Then: SANs cover mandatory identities, mapped route names, and loopback, never the deep wildcard.
  const expected = [
    "web",
    `web.${appName}.internal`,
    "app.lndo.site",
    "*.lndo.site",
    "localhost",
    "127.0.0.1",
  ];
  expect(result.config).toEqual({
    ...serviceCertificatePaths("/tmp/lando-certs", "owner", "web"),
    cn: `web.${appName}.internal`,
    sans: expected,
    caId: "test",
  });
});

test("deduplicates certificate SANs case-insensitively", async () => {
  // When
  const result = await Effect.runPromise(
    resolveCertsFeature({
      appName: "Demo",
      appRoot: "/tmp/certs-dedupe",
      serviceName: "web",
      certs: true,
      hostnames: ["WEB", "web.example.test"],
      routes: [
        { hostname: "Web.Example.Test", filters: [] },
        { hostname: "web.example.test", filters: [] },
      ],
      ...planned,
    }),
  );

  // Then: first occurrence wins per case-insensitive key
  // "WEB" collapses into service identity "web"; route host casing collapses into hostnames entry.
  expect(result.config.sans).toEqual([
    "web",
    "web.Demo.internal",
    "web.example.test",
    "localhost",
    "127.0.0.1",
  ]);
});

test.each([
  { serviceName: "bad host", appName: "demo", identity: "bad host" },
  { serviceName: "web", appName: "bad app", identity: "web.bad app.internal" },
])(
  "rejects mandatory certificate identity $identity with its own remediation",
  async ({ serviceName, appName, identity }) => {
    // When: a service key that cannot appear on a certificate
    const failure = await Effect.runPromise(
      Effect.flip(
        resolveCertsFeature({
          appName,
          appRoot: "/tmp/certs-bad-identity",
          serviceName,
          certs: true,
          hostnames: [],
          routes: [],
          ...planned,
        }),
      ),
    );

    // Then
    expect(failure).toBeInstanceOf(LandofileValidationError);
    expect(failure.issues).toMatchObject([{ path: ["services", serviceName, "certs"] }]);
    expect(failure.issues[0]?.message).toContain(identity);
    expect(failure.remediation).toBe(
      "Use a DNS-shaped service and app name (letters, digits, hyphens, underscores), or set certs to false.",
    );
  },
);
