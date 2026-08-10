import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

import { loadCaPems, resolveServiceNetworkInject } from "../src/network-trust.ts";

describe("core network trust", () => {
  test("loads PEM files with stable UTF-8 SHA-256 digests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-ca-pems-"));
    const firstPath = join(directory, "first.pem");
    const secondPath = join(directory, "second.pem");
    const firstPem = "-----BEGIN CERTIFICATE-----\nfirst\n-----END CERTIFICATE-----\n";
    const secondPem = "-----BEGIN CERTIFICATE-----\nsecond\n-----END CERTIFICATE-----\n";

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

  test("fails unreadable paths with path-named remediation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lando-missing-ca-"));
    const missingPath = join(directory, "missing.pem");

    try {
      const result = await Effect.runPromise(Effect.either(loadCaPems([missingPath])));

      expect(result._tag).toBe("Left");
      if (result._tag !== "Left") throw new Error("expected CA PEM loading to fail");
      expect(result.left._tag).toBe("CaPemLoadError");
      expect(result.left.path).toBe(missingPath);
      expect(result.left.message).toContain(missingPath);
      expect(result.left.remediation).toContain("network.ca.certs");
      expect(result.left.remediation).toContain("LANDO_NETWORK_CA_CERTS");
      expect(result.left.remediation).toContain("security.ca");
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
