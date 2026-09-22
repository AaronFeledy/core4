import { describe, expect, test } from "bun:test";
import { lowerPhpOptions } from "../src/lower-php.ts";
import { type ServiceLoweringContext, emptyPatch } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "appserver",
  keyPath: ["services", "appserver"],
  fallbackSourceId: "base",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

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
      webroot: "web",
      composer: { version: "2.3.10", packages: { "phpunit/phpunit": "*" } },
      xdebug: "debug",
      db_client: "mysql:8.4",
    });
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "rewritten", keyPath: [...ctx.keyPath, "via"] },
      { kind: "rewritten", keyPath: [...ctx.keyPath, "composer_version"] },
      { kind: "unsupported", keyPath: [...ctx.keyPath, "xdebug", "start_with_request"] },
      { kind: "unsupported", keyPath: [...ctx.keyPath, "xdebug", "client_port"] },
      { kind: "unsupported", keyPath: [...ctx.keyPath, "xdebug", "config"] },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "unsupported")).toHaveLength(3);
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
    expect(result.patch).toEqual({ via: "fpm", webroot: "public" });
    expect(result.companions).toEqual({
      "appserver-nginx": { type: "nginx", backend: "appserver", webroot: "public" },
    });
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
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
    expect(result).toEqual({ patch: { via }, diagnostics: [] });
  });

  test.each(["frankenphp", false, null, 42])("drops via when it is %s", (via) => {
    // Given
    const service = { via };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "dropped", keyPath: [...ctx.keyPath, "via"] });
  });

  test("disables Composer when composer_version is false", () => {
    // Given
    const service = { composer_version: false };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result).toEqual({ patch: { composer: false }, diagnostics: [] });
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
    expect(result).toEqual({ patch: { composer: { packages: { "drush/drush": "^12" } } }, diagnostics: [] });
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
    expect(result).toEqual({ patch: { xdebug }, diagnostics: [] });
  });

  test.each([{}, { mode: "" }, { mode: false }])(
    "enables Xdebug when the object has no usable mode: %j",
    (xdebug) => {
      // Given
      const service = { xdebug };
      // When
      const result = lowerPhpOptions(service, ctx);
      // Then
      expect(result).toEqual({ patch: { xdebug: true }, diagnostics: [] });
    },
  );

  test("defers arbitrary Xdebug keys when they have no target", () => {
    // Given
    const service = { xdebug: { custom: 1 } };
    // When
    const result = lowerPhpOptions(service, ctx);
    // Then
    expect(result.patch).toEqual({ xdebug: true });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "unsupported",
      keyPath: [...ctx.keyPath, "xdebug", "custom"],
    });
  });

  test.each([{}, { type: "php", build: ["ignored"] }])(
    "returns an empty patch when PHP options are absent: %j",
    (service) => {
      // Given: a service with no PHP-specific options.
      // When
      const result = lowerPhpOptions(service, ctx);
      // Then
      expect(result).toEqual(emptyPatch);
    },
  );
});
