import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { type Context, Effect, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { networkTrustDoctorStatus } from "../../src/cli/commands/doctor-network-trust.ts";

const roots: string[] = [];
const EMPTY_ENV: NodeJS.ProcessEnv = {};
const makeConfig = (input: unknown): GlobalConfig => Schema.decodeUnknownSync(GlobalConfig)(input);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-network-trust-"));
  roots.push(root);
  return root;
};

const configService = (
  load: Effect.Effect<GlobalConfig, ConfigError>,
): Context.Tag.Service<typeof ConfigService> => ({
  load,
  get: (key) => Effect.map(load, (config) => config[key]),
});

const runStatus = (config: GlobalConfig, env: NodeJS.ProcessEnv) =>
  Effect.runPromise(
    networkTrustDoctorStatus(env).pipe(
      Effect.provide(Layer.succeed(ConfigService, configService(Effect.succeed(config)))),
    ),
  );

describe("network-trust doctor status", () => {
  test("reports empty network configuration as healthy", async () => {
    // Given
    const config = makeConfig({});

    // When
    const result = await runStatus(config, EMPTY_ENV);

    // Then
    expect(result).toEqual({
      name: "network-trust",
      status: "pass",
      severity: "info",
      recovery: "manual",
      context: {
        caConfigured: "false",
        caCount: "0",
        caLoaded: "0",
        caTrustHost: "true",
        caInjectIntoServices: "true",
        proxyConfigured: "false",
        proxyInjectIntoServices: "false",
        noProxyCount: "0",
      },
      solutions: [],
    });
  });

  test("loads a readable real PEM fixture without exposing its contents", async () => {
    // Given
    const root = await tempRoot();
    const path = join(root, "corp-root.pem");
    const pem = rootCertificates[0];
    if (pem === undefined) throw new Error("The runtime did not provide a root certificate fixture.");
    await writeFile(path, pem);
    const config = makeConfig({ network: { ca: { certs: [path] } } });

    // When
    const result = await runStatus(config, EMPTY_ENV);

    // Then
    expect(result.status).toBe("pass");
    expect(result.context).toMatchObject({ caConfigured: "true", caCount: "1", caLoaded: "1" });
    expect(JSON.stringify(result)).not.toContain(pem);
  });

  test("captures an unreadable CA path as a redacted warning with setup remediation", async () => {
    // Given
    const secret = "private-ca-path-secret";
    const path = `/unreadable/${secret}/corp-root.pem`;
    const redactedPath = "/unreadable/[redacted]/corp-root.pem";
    const config = makeConfig({ network: { ca: { certs: [path] } } });

    // When
    const result = await runStatus(config, { LANDO_TEST_SECRET: secret });

    // Then
    expect(result).toMatchObject({
      name: "network-trust",
      status: "warn",
      severity: "warn",
      recovery: "manual",
      context: { failure: "missing-custom-ca" },
      solutions: [{ kind: "manual", command: "lando setup" }],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(redactedPath);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(path);
  });

  test("captures a malformed CA environment array as a diagnostic failure", async () => {
    // Given
    const config = makeConfig({});
    const env: NodeJS.ProcessEnv = { LANDO_NETWORK_CA_CERTS: "not-json" };

    // When
    const result = await runStatus(config, env);

    // Then
    expect(result).toMatchObject({
      status: "warn",
      severity: "warn",
      context: { failure: "missing-custom-ca" },
      solutions: [{ kind: "manual", command: "lando setup" }],
    });
    expect(JSON.stringify(result)).not.toContain(env.LANDO_NETWORK_CA_CERTS);
  });

  test("keeps configured CA trust informational when service injection is disabled", async () => {
    // Given
    const root = await tempRoot();
    const path = join(root, "corp-root.pem");
    const pem = rootCertificates[0];
    if (pem === undefined) throw new Error("The runtime did not provide a root certificate fixture.");
    await writeFile(path, pem);
    const config = makeConfig({
      network: { ca: { certs: [path], injectIntoServices: false, trustHost: false } },
    });

    // When
    const result = await runStatus(config, EMPTY_ENV);

    // Then
    expect(result).toMatchObject({
      status: "pass",
      severity: "info",
      context: { caInjectIntoServices: "false", caTrustHost: "false" },
    });
  });

  test("reports proxy status without exposing proxy credentials or URLs", async () => {
    // Given
    const secret = "proxy-password-secret";
    const proxyUrl = `http://proxy-user:${secret}@proxy.internal:8080`;
    const config = makeConfig({
      network: {
        proxy: {
          http: proxyUrl,
          https: proxyUrl,
          noProxy: ["localhost", ".internal"],
          injectIntoServices: true,
        },
      },
    });

    // When
    const result = await runStatus(config, { LANDO_TEST_SECRET: secret });

    // Then
    expect(result.context).toMatchObject({
      proxyConfigured: "true",
      proxyInjectIntoServices: "true",
      noProxyCount: "2",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(proxyUrl);
  });

  test("lets ConfigService failures propagate", async () => {
    // Given
    const failure = new ConfigError({ message: "config unavailable", path: "/config.yml" });
    const effect = networkTrustDoctorStatus(EMPTY_ENV).pipe(
      Effect.provide(Layer.succeed(ConfigService, configService(Effect.fail(failure)))),
    );

    // When
    const exit = await Effect.runPromiseExit(effect);

    // Then
    expect(exit).toEqual(Effect.runSync(Effect.exit(Effect.fail(failure))));
  });

  test("projects only status fields from resolved network trust", async () => {
    // Given
    const root = await tempRoot();
    const path = join(root, "corp-root.pem");
    const pem = rootCertificates[0];
    if (pem === undefined) throw new Error("The runtime did not provide a root certificate fixture.");
    await writeFile(path, pem);
    const config = makeConfig({
      network: {
        ca: { certs: [path] },
        proxy: { https: "http://user:secret@proxy.internal", noProxy: ["localhost"] },
      },
    });

    // When
    const result = await runStatus(config, EMPTY_ENV);

    // Then
    expect(Object.keys(result.context)).toEqual([
      "caConfigured",
      "caCount",
      "caLoaded",
      "caTrustHost",
      "caInjectIntoServices",
      "proxyConfigured",
      "proxyInjectIntoServices",
      "noProxyCount",
    ]);
    expect(JSON.stringify(result)).not.toContain(path);
    expect(JSON.stringify(result)).not.toContain("CERTIFICATE");
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/u);
    expect(JSON.stringify(result)).not.toContain("proxy.internal");
  });
});
