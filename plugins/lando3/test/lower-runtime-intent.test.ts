import { describe, expect, test } from "bun:test";
import { LandofileShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { withoutHostAlias, withoutHostIpVariable } from "../src/host-reachability.ts";
import { lowerScannerAndHome, withHomeIntent } from "../src/lower-runtime-intent.ts";
import type { LoweringPatch, ServiceLoweringContext } from "../src/lowering-contract.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: "source",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const summary = (diagnostics: LoweringPatch["diagnostics"]) =>
  diagnostics.map(({ kind, keyPath }) => `${kind} ${keyPath.join(".")}`);
const lowered = (patch: Record<string, unknown>): LoweringPatch => ({ patch, diagnostics: [] });

const translate = (text: string) =>
  Effect.runPromise(
    makeLando3ConfigTranslator({
      decomposers: fakeDecomposers().decomposers,
      redactor: createRedactor("secrets"),
    }).translate(documentSet([document(".lando.yml", text)])),
  );

describe("scanner", () => {
  test("maps a settings object onto the bounded Lando 4 probe", () => {
    // Given Lando 3 per-attempt timeout, a retry count above the Lando 4 cap, and a relative path.
    const result = lowerScannerAndHome(
      {
        scanner: { okCodes: [200, 301, 99, "x"], retry: 25, timeout: 1000, path: "health", maxRedirects: 6 },
      },
      ctx,
    );
    // Then retries cap at 20 and one deadline covers all 21 attempts.
    expect(result.patch).toEqual({
      scanner: { path: "/health", okCodes: [200, 301], retries: 20, timeout: 21000 },
    });
    expect(summary(result.diagnostics)).toEqual([
      "dropped services.web.scanner.okCodes.2",
      "dropped services.web.scanner.okCodes.3",
      "dropped services.web.scanner.maxRedirects",
      "rewritten services.web.scanner",
    ]);
  });

  test("uses the default retry budget when only a timeout is authored", () => {
    const result = lowerScannerAndHome({ scanner: { timeout: 500_000 } }, ctx);
    expect(result.patch).toEqual({ scanner: { timeout: 600_000 } });
  });

  test("respells a scanner path and refuses one Lando 4 cannot hold", () => {
    const respelled = lowerScannerAndHome({ scanner: { path: "${HEALTH}" } }, ctx);
    expect(respelled.patch).toEqual({ scanner: { path: "/$HEALTH" } });
    const refused = lowerScannerAndHome({ scanner: { path: "${HEALTH:-x}", okCodes: 200 } }, ctx);
    expect(refused.patch).toEqual({ scanner: {} });
    expect(summary(refused.diagnostics)).toEqual([
      "unsupported services.web.scanner.path",
      "dropped services.web.scanner.okCodes",
    ]);
  });

  test("does not claim a rewrite when retry cannot lower", () => {
    const result = lowerScannerAndHome({ scanner: { retry: "nope" } }, ctx);
    expect(result.patch).toEqual({ scanner: {} });
    expect(summary(result.diagnostics)).toEqual(["dropped services.web.scanner.retry"]);
  });

  test("keeps false and drops the redundant true", () => {
    expect(lowerScannerAndHome({ scanner: false }, ctx)).toEqual({
      patch: { scanner: false },
      diagnostics: [],
    });
    const enabled = lowerScannerAndHome({ scanner: true }, ctx);
    expect(enabled.patch).toEqual({});
    expect(summary(enabled.diagnostics)).toEqual(["dropped services.web.scanner"]);
  });
});

describe("home", () => {
  test.each([
    [false, false],
    ["/var/www", { path: "/var/www" }],
    [{ path: "/home/app" }, { path: "/home/app" }],
  ])("rewrites an authored home %p", (home, expected) => {
    const result = lowerScannerAndHome({ home }, ctx);
    expect(result.patch).toEqual({ home: expected });
    expect(summary(result.diagnostics)).toEqual(["rewritten services.web.home"]);
  });

  test("drops a relative home path", () => {
    const result = lowerScannerAndHome({ home: "var/www" }, ctx);
    expect(result.patch).toEqual({});
    expect(summary(result.diagnostics)).toEqual(["dropped services.web.home"]);
  });

  test("respells a home path shell reference before emitting it", () => {
    const result = lowerScannerAndHome({ home: "/var/www/${NAME}" }, ctx);
    expect(result.patch).toEqual({ home: { path: "/var/www/$NAME" } });
  });

  test.each([
    ["php:8.3", undefined],
    ["node:22", "node"],
    ["apache", "www-data"],
    ["solr:9", undefined],
  ])("keeps the Lando 4 default home for %s as %p", (type, user) => {
    const input = lowered({ type, ...(user === undefined ? {} : { user }) });
    expect(withHomeIntent(input, {}, ctx)).toBe(input);
  });

  test("disables home with path remediation when the catalog user has no declared home", () => {
    const result = withHomeIntent(lowered({ type: "php:8.3", user: "www-data" }), {}, ctx);
    expect(result.patch).toEqual({ type: "php:8.3", user: "www-data", home: false });
    expect(summary(result.diagnostics)).toEqual(["needs-review services.web"]);
    expect(result.diagnostics[0]?.remediation).toContain("services.web.home.path");
  });

  test.each([
    ["an image", { type: "lando", image: "custom:1" }],
    ["a build context", { type: "lando", build: { context: "." } }],
    ["a catalog override image", { type: "node:22", image: "custom:1" }],
  ])("disables home with unknown-image remediation for %s", (_label, patch) => {
    const result = withHomeIntent(lowered(patch), { api: 4 }, ctx);
    expect(result.patch.home).toBe(false);
    expect(result.diagnostics[0]?.message).toContain("image comes from the Landofile");
  });

  test("marks a raw Compose service homeless because Lando 3 never gave it a home", () => {
    const result = withHomeIntent(lowered({ type: "compose", image: "redis:7" }), { type: "compose" }, ctx);
    expect(result.patch.home).toBe(false);
    expect(summary(result.diagnostics)).toEqual(["generated services.web"]);
  });

  test("leaves authored home and blocked services alone", () => {
    const authored = lowered({ type: "lando", image: "custom:1", home: { path: "/srv" } });
    expect(withHomeIntent(authored, { api: 4 }, ctx)).toBe(authored);
    const blocked: LoweringPatch = { patch: { type: "lando", image: "x" }, diagnostics: [], blocked: true };
    expect(withHomeIntent(blocked, { api: 4 }, ctx)).toBe(blocked);
  });
});

describe("host reachability", () => {
  test("removes a hand-wired alias from list and map extra_hosts", () => {
    const diagnostics: LoweringPatch["diagnostics"][number][] = [];
    expect(
      withoutHostAlias(
        ["host.lando.internal:host-gateway", "api.local:host-gateway"],
        ctx,
        ["overrides", "extra_hosts"],
        diagnostics,
      ),
    ).toEqual(["api.local:host-gateway"]);
    expect(
      withoutHostAlias({ "host.lando.internal": "host-gateway" }, ctx, ["extra_hosts"], diagnostics),
    ).toBeUndefined();
    expect(
      withoutHostAlias(["HOST.LANDO.INTERNAL:172.17.0.1"], ctx, ["extra_hosts"], diagnostics),
    ).toBeUndefined();
    expect(summary(diagnostics)).toEqual([
      "rewritten services.web.overrides.extra_hosts.0",
      "rewritten services.web.extra_hosts.host.lando.internal",
      "rewritten services.web.extra_hosts.0",
    ]);
  });

  test("drops an authored LANDO_HOST_IP", () => {
    const diagnostics: LoweringPatch["diagnostics"][number][] = [];
    expect(withoutHostIpVariable({ LANDO_HOST_IP: "1.2.3.4" }, ctx, ["environment"], diagnostics)).toEqual(
      {},
    );
    expect(summary(diagnostics)).toEqual(["rewritten services.web.environment.LANDO_HOST_IP"]);
  });
});

describe("converted Landofile", () => {
  test("adds no legacy mounts, variables, or fabricated host address", async () => {
    // Given a Lando 3 app that relied on the implicit home, helper, and host wiring.
    const result = await translate(
      [
        "name: legacy",
        "services:",
        "  appserver:",
        "    type: php:8.3",
        "    meUser: www-data",
        "    scanner: {okCodes: [401], retry: 3, timeout: 2000}",
        "    overrides:",
        "      extra_hosts: ['host.lando.internal:host-gateway']",
        "      environment: {LANDO_HOST_IP: 172.17.0.1, XDEBUG_MODE: debug}",
        "  node:",
        "    type: node:22",
        "    scanner: false",
        "  cache:",
        "    type: compose",
        "    services: {image: 'redis:7'}",
      ].join("\n"),
    );
    // Then the output is valid Lando 4 authoring and carries none of the legacy wiring.
    const fragments = result.outputs.map(({ fragment }) => fragment);
    for (const fragment of fragments) {
      expect(Schema.decodeUnknownEither(LandofileShape)(fragment)._tag).toBe("Right");
    }
    const text = JSON.stringify(fragments);
    for (const legacy of [
      "/lando",
      "/helpers",
      "/user",
      "LANDO_MOUNT",
      "LANDO_HOST_IP",
      "host.lando.internal",
    ]) {
      expect(text).not.toContain(legacy);
    }
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(fragments).toEqual([
      {
        name: "legacy",
        services: {
          appserver: {
            type: "php:8.3",
            user: "www-data",
            scanner: { okCodes: [401], retries: 3, timeout: 8000 },
            environment: { XDEBUG_MODE: "debug" },
            home: false,
          },
          node: { type: "node:22", scanner: false },
          cache: { type: "compose", image: "redis:7", home: false },
        },
      },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toEqual([]);
  });
});
