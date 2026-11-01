import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { makeLandoPaths, networkTrustCaBundlePath } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";

import { ensureNetworkTrustCaBundle } from "../../src/cli/commands/bun-child-ca-bundle.ts";
import {
  BUN_CAFILE_FLAG,
  BUN_CHILD_PROXY_ENV_NAMES,
  BUN_NO_INSTALL_FLAG,
  NODE_EXTRA_CA_CERTS_ENV,
  applyProxyPlanToEnv,
  applyRemoveEnv,
  resolveBunChildCaMode,
} from "../../src/cli/commands/bun-child-network-policy.ts";
import {
  BunChildNetworkPolicyError,
  projectBunChildNetwork,
} from "../../src/cli/commands/bun-child-network.ts";

const PEM_A = new X509Certificate(rootCertificates[0] ?? "").toString();
const PEM_B = new X509Certificate(rootCertificates[1] ?? "").toString();

test("applyProxyPlanToEnv clears ALL_PROXY and lowercase spellings then sets canonical values", () => {
  const env: Record<string, string> = {
    HTTP_PROXY: "http://old:1",
    http_proxy: "http://lower:1",
    HTTPS_PROXY: "http://old:2",
    https_proxy: "http://lower:2",
    ALL_PROXY: "http://all:7",
    all_proxy: "http://all-lower:8",
    NO_PROXY: "old.example",
    no_proxy: "lower.example",
    KEEP: "yes",
  };
  applyProxyPlanToEnv(env, {
    http: "http://canonical:80",
    https: "http://canonical:443",
    noProxy: ["localhost", ".internal"],
  });
  for (const name of BUN_CHILD_PROXY_ENV_NAMES) {
    if (name === "HTTP_PROXY" || name === "HTTPS_PROXY" || name === "NO_PROXY") continue;
    expect(env[name]).toBeUndefined();
  }
  expect(env).toMatchObject({
    HTTP_PROXY: "http://canonical:80",
    HTTPS_PROXY: "http://canonical:443",
    NO_PROXY: "localhost,.internal",
    KEEP: "yes",
  });
  expect(env.ALL_PROXY).toBeUndefined();
  expect(env.all_proxy).toBeUndefined();
});

test("applyProxyPlanToEnv preserves explicit null/absent decisions by leaving proxies unset", () => {
  const env: Record<string, string> = {
    HTTP_PROXY: "http://ambient:9",
    ALL_PROXY: "http://all:7",
    NO_PROXY: "*",
  };
  applyProxyPlanToEnv(env, { noProxy: [] });
  expect(env.HTTP_PROXY).toBeUndefined();
  expect(env.HTTPS_PROXY).toBeUndefined();
  expect(env.ALL_PROXY).toBeUndefined();
  expect(env.NO_PROXY).toBeUndefined();
});

test("applyRemoveEnv drops conflicting token spellings case-insensitively", () => {
  const env: Record<string, string> = {
    BUN_AUTH_TOKEN: "legacy",
    bun_config_token: "lower-conflict",
    BUN_CONFIG_TOKEN: "desired",
    NPM_CONFIG_TOKEN: "npm",
    npm_config_token: "npm-lower",
    KEEP: "1",
  };
  // Publish sets BUN_CONFIG_TOKEN via env and only lists conflicting inherited names.
  applyRemoveEnv(env, ["BUN_AUTH_TOKEN", "NPM_CONFIG_TOKEN"]);
  expect(env.BUN_AUTH_TOKEN).toBeUndefined();
  expect(env.NPM_CONFIG_TOKEN).toBeUndefined();
  expect(env.npm_config_token).toBeUndefined();
  expect(env.BUN_CONFIG_TOKEN).toBe("desired");
  expect(env.bun_config_token).toBe("lower-conflict");
  expect(env.KEEP).toBe("1");
});

test("resolveBunChildCaMode uses NODE_EXTRA under host trust and --cafile under strict package verbs", () => {
  expect(
    resolveBunChildCaMode({
      trustHost: true,
      hasCustomCa: true,
      verb: "install",
      argv: ["install"],
      bundlePath: "/cache/bundle.pem",
    }),
  ).toEqual({ mode: "extra", bundlePath: "/cache/bundle.pem" });
  expect(
    resolveBunChildCaMode({
      trustHost: false,
      hasCustomCa: true,
      verb: "publish",
      argv: ["publish", "--tag", "latest"],
      bundlePath: "/cache/bundle.pem",
    }),
  ).toEqual({ mode: "cafile", bundlePath: "/cache/bundle.pem" });
  expect(
    resolveBunChildCaMode({
      trustHost: false,
      hasCustomCa: false,
      verb: "install",
      argv: ["install"],
    }),
  ).toEqual({ mode: "fail-empty-strict" });
  expect(
    resolveBunChildCaMode({
      trustHost: false,
      hasCustomCa: true,
      verb: "x",
      argv: ["x", "hello"],
      bundlePath: "/cache/bundle.pem",
    }),
  ).toEqual({ mode: "bunx-no-install" });
});

test("ensureNetworkTrustCaBundle writes once and skips identical rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-ca-bundle-"));
  try {
    const cas = [
      { path: "a", pem: PEM_A, digest: sha256Hex(PEM_A) },
      { path: "b", pem: PEM_B, digest: sha256Hex(PEM_B) },
    ];
    const first = await Effect.runPromise(ensureNetworkTrustCaBundle({ userCacheRoot: root, cas }));
    expect(first?.bundlePath).toBe(networkTrustCaBundlePath(root, sha256Hex(PEM_A + PEM_B)));
    if (first === undefined) throw new Error("Expected a CA bundle");
    const body = await readFile(first.bundlePath, "utf8");
    expect(body).toBe(PEM_A + PEM_B);
    await utimes(first.bundlePath, new Date(1000), new Date(1000));
    const before = await stat(first.bundlePath);
    const second = await Effect.runPromise(ensureNetworkTrustCaBundle({ userCacheRoot: root, cas }));
    expect(second?.bundlePath).toBe(first?.bundlePath);
    const after = await stat(first.bundlePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projectBunChildNetwork merges parent NODE_EXTRA only when host trust is retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-net-proj-"));
  try {
    const parentExtra = join(root, "parent-extra.pem");
    const custom = join(root, "custom.pem");
    await writeFile(parentExtra, PEM_A);
    await writeFile(custom, PEM_B);
    const cache = join(root, "cache");
    await writeFile(join(root, "marker"), "");
    // Force paths via env
    const env: Record<string, string> = {
      LANDO_USER_CACHE_ROOT: cache,
      LANDO_USER_DATA_ROOT: join(root, "data"),
      LANDO_USER_CONF_ROOT: join(root, "conf"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
      [NODE_EXTRA_CA_CERTS_ENV]: parentExtra,
      ALL_PROXY: "http://all:7",
      HTTP_PROXY: "http://ambient:1",
    };
    const projected = await Effect.runPromise(
      projectBunChildNetwork({
        env,
        argv: ["install"],
        verb: "install",
        parentEnv: { [NODE_EXTRA_CA_CERTS_ENV]: parentExtra },
        plan: {
          proxy: { http: "http://plan:80", https: "http://plan:443", noProxy: ["localhost"] },
          caCertPaths: [custom],
          trustHost: true,
        },
      }),
    );
    expect(projected.env.ALL_PROXY).toBeUndefined();
    expect(projected.env.HTTP_PROXY).toBe("http://plan:80");
    expect(projected.env.HTTPS_PROXY).toBe("http://plan:443");
    expect(projected.env.NO_PROXY).toBe("localhost");
    expect(projected.env[NODE_EXTRA_CA_CERTS_ENV]).toBeDefined();
    const projectedBundle = projected.env[NODE_EXTRA_CA_CERTS_ENV];
    if (projectedBundle === undefined) throw new Error("Expected projected CA bundle");
    const bundle = await readFile(projectedBundle, "utf8");
    expect(bundle).toContain(PEM_A);
    expect(bundle).toContain(PEM_B);
    expect(projectedBundle).toStartWith(cache);
    expect(projected.argv).toEqual(["install"]);

    const strictEnv: Record<string, string> = {
      LANDO_USER_CACHE_ROOT: cache,
      [NODE_EXTRA_CA_CERTS_ENV]: parentExtra,
    };
    const strict = await Effect.runPromise(
      projectBunChildNetwork({
        env: strictEnv,
        argv: ["install"],
        verb: "install",
        parentEnv: { [NODE_EXTRA_CA_CERTS_ENV]: parentExtra },
        plan: {
          proxy: { noProxy: [] },
          caCertPaths: [custom],
          trustHost: false,
        },
      }),
    );
    expect(strict.env[NODE_EXTRA_CA_CERTS_ENV]).toBeUndefined();
    if (strict.bundlePath === undefined) throw new Error("Expected strict CA bundle");
    expect(strict.argv).toEqual(["install", BUN_CAFILE_FLAG, strict.bundlePath]);
    const strictBody = await readFile(strict.bundlePath, "utf8");
    expect(strictBody).toContain(PEM_B);
    expect(strictBody).not.toContain(PEM_A);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projectBunChildNetwork fails empty strict trust and confines bunx with --no-install", async () => {
  const empty = await Effect.runPromise(
    Effect.flip(
      projectBunChildNetwork({
        env: {},
        argv: ["install"],
        verb: "install",
        plan: { proxy: { noProxy: [] }, caCertPaths: [], trustHost: false },
      }),
    ),
  );
  expect(empty).toBeInstanceOf(BunChildNetworkPolicyError);
  expect(empty).toMatchObject({ kind: "empty-strict-trust" });

  const root = await mkdtemp(join(tmpdir(), "lando-bunx-"));
  try {
    const custom = join(root, "ca.pem");
    await writeFile(custom, PEM_A);
    const env: Record<string, string> = { LANDO_USER_CACHE_ROOT: join(root, "cache") };
    const bunx = await Effect.runPromise(
      projectBunChildNetwork({
        env,
        argv: ["x", "hello-bin"],
        verb: "x",
        plan: { proxy: { noProxy: [] }, caCertPaths: [custom], trustHost: false },
      }),
    );
    expect(bunx.argv).toEqual(["x", BUN_NO_INSTALL_FLAG, "hello-bin"]);
    expect(bunx.env[NODE_EXTRA_CA_CERTS_ENV]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("makeLandoPaths network helpers stay under user cache", () => {
  const paths = makeLandoPaths({
    platform: "linux",
    home: "/home/t",
    env: {},
    userCacheRoot: "/c",
    userDataRoot: "/d",
    userConfRoot: "/f",
  });
  expect(networkTrustCaBundlePath(paths.roots.userCacheRoot, "ab", "linux")).toBe(
    "/c/network-trust/ca-bundles/ab.pem",
  );
});
