import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { testCaPem } from "@lando/sdk/test";
import {
  loadCaPems,
  resolveServiceNetworkInject,
  resolveTrust,
  withWindowsHostTrust,
} from "../src/network-trust.ts";

describe("Windows host CA trust", () => {
  const configured = {
    proxy: { https: "http://proxy.example:3128", noProxy: ["localhost"] },
    caPems: ["custom-root"],
    trustHost: true,
  } as const;

  test("passes Windows system roots explicitly alongside configured roots", () => {
    expect(withWindowsHostTrust(configured, ["system-root"], "win32")).toEqual({
      proxy: configured.proxy,
      caPems: ["system-root", "custom-root"],
      trustHost: false,
    });
    expect(withWindowsHostTrust(undefined, ["system-root"], "win32")).toEqual({
      proxy: { noProxy: [] },
      caPems: ["system-root"],
      trustHost: false,
    });
  });

  test("keeps explicit host opt-out and other platforms unchanged", () => {
    const isolated = { ...configured, trustHost: false };
    expect(withWindowsHostTrust(isolated, ["system-root"], "win32")).toBe(isolated);
    expect(withWindowsHostTrust(configured, ["system-root"], "linux")).toBe(configured);
    expect(withWindowsHostTrust(undefined, ["system-root"], "darwin")).toBeUndefined();
    expect(withWindowsHostTrust(undefined, [], "win32")).toBeUndefined();
  });
});

describe("core network trust", () => {
  test("loads PEM files with stable UTF-8 SHA-256 digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-ca-pems-"));
    const firstPath = join(directory, "first.pem");
    const secondPath = join(directory, "second.pem");
    const firstPem = testCaPem(0);
    const secondPem = testCaPem(1);

    try {
      await writeFile(firstPath, firstPem, "utf-8");
      await writeFile(secondPath, secondPem, "utf-8");

      const loaded = await Effect.runPromise(loadCaPems([firstPath, secondPath]));

      expect(loaded).toEqual([
        {
          path: firstPath,
          pem: firstPem,
          digest: createHash("sha256").update(firstPem, "utf-8").digest("hex"),
        },
        {
          path: secondPath,
          pem: secondPem,
          digest: createHash("sha256").update(secondPem, "utf-8").digest("hex"),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["text with no certificate block", "not a certificate\n"],
    [
      "a certificate block that does not parse",
      "-----BEGIN CERTIFICATE-----\nbogus\n-----END CERTIFICATE-----\n",
    ],
  ])("rejects %s at load, naming the file", async (_label, contents) => {
    // Given: a configured CA file Bun would otherwise reject later as FailedToOpenSocket.
    const directory = await mkdtemp(join(tmpdir(), "lando-bad-ca-"));
    const badPath = join(directory, "corp-root.pem");
    try {
      await writeFile(badPath, contents, "utf-8");
      // When
      const result = await Effect.runPromise(Effect.result(loadCaPems([badPath])));
      // Then
      if (result._tag !== "Failure") throw new Error("expected CA PEM loading to fail");
      expect(result.failure).toMatchObject({ _tag: "CaPemLoadError", path: badPath });
      expect(result.failure.message).toContain(badPath);
      expect(result.failure.remediation).toContain("BEGIN CERTIFICATE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails unreadable paths with path-named remediation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-missing-ca-"));
    const missingPath = join(directory, "missing.pem");

    try {
      const result = await Effect.runPromise(Effect.result(loadCaPems([missingPath])));

      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected CA PEM loading to fail");
      expect(result.failure._tag).toBe("CaPemLoadError");
      expect(result.failure.path).toBe(missingPath);
      expect(result.failure.message).toContain(missingPath);
      expect(result.failure.remediation).toContain("network.ca.certs");
      expect(result.failure.remediation).toContain("LANDO_NETWORK_CA_CERTS");
      expect(result.failure.remediation).toContain("security.ca");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses asymmetric defaults when decoded config omits network parents", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({});

    const resolved = resolveServiceNetworkInject({ network: config.network, env: {} });

    expect(resolved).toEqual({
      injectCa: true,
      injectProxy: false,
      caPaths: [],
      landofileCaPaths: [],
      proxy: { noProxy: [] },
    });
  });

  test("preserves defaults when decoded config explicitly has an empty CA cert list", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: { ca: { certs: [] } },
    });

    const resolved = resolveServiceNetworkInject({ network: config.network, env: {} });

    expect(resolved).toEqual({
      injectCa: true,
      injectProxy: false,
      caPaths: [],
      landofileCaPaths: [],
      proxy: { noProxy: [] },
    });
  });

  test("returns global and Landofile CA paths in their separate ordered inputs", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: { ca: { certs: ["/global-first.pem", "/global-second.pem"] } },
    });

    const resolved = resolveServiceNetworkInject({
      network: config.network,
      env: {},
      security: { ca: ["./project.pem"] },
    });

    expect(resolved.caPaths).toEqual(["/global-first.pem", "/global-second.pem"]);
    expect(resolved.landofileCaPaths).toEqual(["./project.pem"]);
  });

  test("uses configured global inject flags when service overrides are absent", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: {
        ca: { certs: ["/global.pem"], injectIntoServices: false },
        proxy: { https: "http://proxy.example:3128", injectIntoServices: true },
      },
    });

    const resolved = resolveServiceNetworkInject({ network: config.network, env: {} });

    expect(resolved).toEqual({
      injectCa: false,
      injectProxy: true,
      caPaths: [],
      landofileCaPaths: [],
      proxy: { https: "http://proxy.example:3128", noProxy: [] },
    });
  });

  test("applies service overrides without dropping Landofile CA paths", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: {
        ca: { certs: ["/global.pem"], injectIntoServices: true },
        proxy: { https: "http://proxy.example:3128", injectIntoServices: true },
      },
    });

    const resolved = resolveServiceNetworkInject({
      network: config.network,
      env: {},
      security: {
        ca: ["./service.pem"],
        inheritNetworkCa: false,
        inheritNetworkProxy: false,
      },
    });

    expect(resolved).toEqual({
      injectCa: false,
      injectProxy: false,
      caPaths: [],
      landofileCaPaths: ["./service.pem"],
      proxy: { https: "http://proxy.example:3128", noProxy: [] },
    });
  });
});

describe("resolveTrust", () => {
  test("returns injected trust without reading ConfigService", async () => {
    const injected = {
      proxy: { https: "http://proxy.example:3128", noProxy: [] as const },
      caPems: ["injected-pem"],
      trustHost: false,
    };
    let loaded = false;
    const context = Context.make(
      ConfigService,
      ConfigService.of({
        load: Effect.sync(() => {
          loaded = true;
          return Schema.decodeUnknownSync(GlobalConfig)({});
        }),
        get: () => Effect.die("injected trust must not read config"),
      }),
    );
    const resolved = await Effect.runPromise(resolveTrust(context, injected, {}));
    expect(resolved).toEqual(injected);
    expect(loaded).toBe(false);
  });

  test("returns undefined when ConfigService is absent", async () => {
    const resolved = await Effect.runPromise(resolveTrust(Context.empty(), undefined, {}));
    expect(resolved).toBeUndefined();
  });

  test("loads plan from ConfigService and CA PEMs from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-resolve-trust-"));
    const caPath = join(directory, "custom.pem");
    const pem = testCaPem(2);
    try {
      await writeFile(caPath, pem, "utf-8");
      const config = Schema.decodeUnknownSync(GlobalConfig)({
        network: {
          ca: { certs: [caPath], trustHost: false },
          proxy: { https: "http://cfg-proxy:8080" },
        },
      });
      const context = Context.make(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
      );
      const resolved = await Effect.runPromise(resolveTrust(context, undefined, {}));
      expect(resolved).toEqual({
        proxy: { https: "http://cfg-proxy:8080", noProxy: [] },
        caPems: [pem],
        trustHost: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails with HttpTrustError when a CA path is unreadable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-resolve-trust-miss-"));
    const missing = join(directory, "missing.pem");
    try {
      const config = Schema.decodeUnknownSync(GlobalConfig)({
        network: { ca: { certs: [missing] } },
      });
      const context = Context.make(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
      );
      const result = await Effect.runPromise(Effect.result(resolveTrust(context, undefined, {})));
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected resolveTrust failure");
      expect(result.failure._tag).toBe("HttpTrustError");
      expect(result.failure.kind).toBe("missing-custom-ca");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
