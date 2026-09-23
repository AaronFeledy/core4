import { describe, expect, test } from "bun:test";
import { lowerPhpOptions } from "../src/lower-php.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "appserver",
  keyPath: ["services", "appserver"],
  fallbackSourceId: "base",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

const implicitReview = expect.objectContaining({ kind: "needs-review", keyPath: [...ctx.keyPath, "type"] });
const xdebugRewrite = expect.objectContaining({ kind: "rewritten", keyPath: [...ctx.keyPath, "xdebug"] });

describe("lowerPhpOptions", () => {
  test("lowers PHP options when legacy options are combined", () => {
    // Given
    const service = {
      via: "apache:2.4",
      webroot: "web",
      composer_version: "2.3.10",
      composer: { "phpunit/phpunit": "*" },
      xdebug: {
        mode: "debug",
        start_with_request: "yes",
        client_port: 9003,
        config: { max_nesting_level: 256 },
      },
      db_client: "mysql:8.4",
    };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({
      via: "apache",
      webroot: "/app/web",
      composer: { version: "2.3.10", packages: { "phpunit/phpunit": "*" } },
      xdebug: "debug",
      environment: {
        XDEBUG_CONFIG: "client_host=host.docker.internal client_port=9003 start_with_request=yes",
      },
      db_client: "mysql:8.4",
    });
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "needs-review", keyPath: [...ctx.keyPath, "type"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "via"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "composer_version"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "xdebug"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "xdebug", "start_with_request"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "xdebug", "client_port"] },
      { kind: "dropped", keyPath: [...ctx.keyPath, "xdebug", "config", "max_nesting_level"] },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toHaveLength(0);
    expect(
      result.diagnostics
        .filter(({ kind }) => kind === "dropped")
        .every(({ remediation }) => remediation?.includes("PHP ini file")),
    ).toBe(true);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.remediation?.trim().length).toBeGreaterThan(0);
    }
  });

  test.each(["nginx", "nginx:1.25"])("generates a companion when via is %s", (via) => {
    // Given
    const service = { via, webroot: "public" };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({ via: "fpm", webroot: "/app/public" });
    expect(result.companions).toEqual({
      "appserver-nginx": { type: "nginx", backend: "appserver", webroot: "/app/public" },
    });
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "needs-review", keyPath: [...ctx.keyPath, "type"] },
      { kind: "generated", keyPath: [...ctx.keyPath, "via"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "via"] },
    ]);
  });

  test("omits the companion webroot when none was authored", () => {
    // Given
    const service = { via: "nginx" };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.companions).toEqual({ "appserver-nginx": { type: "nginx", backend: "appserver" } });
  });

  test.each(["apache", "cli", "fpm"])("preserves via when it is %s", (via) => {
    // Given
    const service = { via };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result).toEqual({ patch: { via }, diagnostics: [implicitReview] });
  });

  test.each(["frankenphp", false, null, 42])("drops via when it is %s", (via) => {
    // Given
    const service = { via };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0]).toEqual(implicitReview);
    expect(result.diagnostics[1]).toMatchObject({ kind: "dropped", keyPath: [...ctx.keyPath, "via"] });
  });

  test("disables Composer when composer_version is false", () => {
    // Given
    const service = { composer_version: false };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result).toEqual({ patch: { composer: false }, diagnostics: [implicitReview] });
  });

  test("preserves disabling Composer when packages are also present", () => {
    // Given
    const service = { composer_version: false, composer: { "drush/drush": "^12" } };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({ composer: false });
  });

  test("omits Composer version when only global packages are present", () => {
    // Given
    const service = { composer: { "drush/drush": "^12" } };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result).toEqual({
      patch: { composer: { packages: { "drush/drush": "^12" } } },
      diagnostics: [implicitReview],
    });
  });

  test("stringifies global package constraints when they are scalars", () => {
    // Given
    const service = { composer: { "vendor/tool": 12 } };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({ composer: { packages: { "vendor/tool": "12" } } });
  });

  test.each([true, false, "debug,develop"])("preserves scalar Xdebug when it is %s", (xdebug) => {
    // Given
    const service = { xdebug };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result).toEqual({ patch: { xdebug }, diagnostics: [implicitReview] });
  });

  test.each([{}, { mode: "" }, { mode: false }])(
    "enables Xdebug when the object has no usable mode: %j",
    (xdebug) => {
      // Given
      const service = { xdebug };
      // When
      const result = lowerPhpOptions(service, ctx);
      // Then
      expect(result).toEqual({ patch: { xdebug: true }, diagnostics: [implicitReview, xdebugRewrite] });
    },
  );

  test("drops arbitrary Xdebug keys with ini remediation", () => {
    // Given
    const service = { xdebug: { custom: 1 } };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({ xdebug: true });
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics[0]).toEqual(implicitReview);
    expect(result.diagnostics[1]).toEqual(xdebugRewrite);
    expect(result.diagnostics[2]).toMatchObject({
      kind: "dropped",
      keyPath: [...ctx.keyPath, "xdebug", "custom"],
    });
    expect(result.diagnostics[2]?.remediation).toContain("PHP ini file");
  });

  test.each([{}, { type: "php", build: ["ignored"] }])(
    "reports implicit PHP behavior without adding fields when options are absent: %j",
    (service) => {
      // Given: a service with no PHP-specific options.
      // When
      const result = lowerPhpOptions(service, ctx);
      // Then
      expect(result).toEqual({ patch: {}, diagnostics: [implicitReview] });
    },
  );
});
