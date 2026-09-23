import { describe, expect, test } from "bun:test";
import { lowerCatalogCommon } from "../src/lower-catalog-common.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "app",
  keyPath: ["services", "app"],
  fallbackSourceId: "base",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

describe("lowerCatalogCommon", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly service: Record<string, unknown>;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly kinds: readonly string[];
  }> = [
    {
      name: "unpinned MySQL publication",
      service: {
        type: "mysql:8.0",
        portforward: true,
        creds: { user: "app", password: "secret", database: "app" },
      },
      patch: {
        type: "mysql:8.0",
        ports: ["3306"],
        creds: { user: "app", password: "secret", database: "app" },
      },
      kinds: ["rewritten"],
    },
    {
      name: "numeric MariaDB host port",
      service: { type: "mariadb:11.4", portforward: 3307 },
      patch: { type: "mariadb:11.4", ports: ["3307:3306"] },
      kinds: ["rewritten"],
    },
    {
      name: "string MariaDB host port",
      service: { type: "mariadb:11.4", portforward: "3308" },
      patch: { type: "mariadb:11.4", ports: ["3308:3306"] },
      kinds: ["rewritten"],
    },
    {
      name: "disabled publication",
      service: { type: "mysql:8.0", portforward: false },
      patch: { type: "mysql:8.0" },
      kinds: [],
    },
    {
      name: "publication without catalog port",
      service: { type: "php:8.3", portforward: true },
      patch: { type: "php:8.3" },
      kinds: ["dropped"],
    },
    {
      name: "PHP config slots",
      service: {
        type: "php:8.3",
        config: {
          php: "config/php.ini",
          vhosts: "config/default.conf",
          pool: "config/pool.conf",
          server: "config/apache.conf",
        },
      },
      patch: {
        type: "php:8.3",
        mounts: [
          {
            type: "bind",
            source: "config/php.ini",
            target: "/usr/local/etc/php/conf.d/zzz-lando-my-custom.ini",
            readOnly: true,
          },
          {
            type: "bind",
            source: "config/default.conf",
            target: "/etc/apache2/sites-enabled/000-default.conf",
            readOnly: true,
          },
          {
            type: "bind",
            source: "config/pool.conf",
            target: "/usr/local/etc/php-fpm.d/zz-lando.conf",
            readOnly: true,
          },
          { type: "bind", source: "config/apache.conf", target: "/etc/apache2/apache2.conf", readOnly: true },
        ],
      },
      kinds: ["rewritten", "rewritten", "rewritten", "rewritten"],
    },
    {
      name: "nginx server and vhosts stay separate mounts",
      service: {
        type: "nginx",
        config: {
          server: "config/nginx.conf",
          vhosts: "config/default.conf",
          params: "config/fastcgi_params",
        },
      },
      patch: {
        type: "nginx",
        mounts: [
          { type: "bind", source: "config/nginx.conf", target: "/etc/nginx/nginx.conf", readOnly: true },
          {
            type: "bind",
            source: "config/default.conf",
            target: "/etc/nginx/conf.d/default.conf",
            readOnly: true,
          },
        ],
      },
      kinds: ["rewritten", "rewritten", "dropped"],
    },
    {
      name: "Apache server and vhosts stay separate mounts",
      service: { type: "apache", config: { server: "config/httpd.conf", vhosts: "config/default.conf" } },
      patch: {
        type: "apache",
        mounts: [
          {
            type: "bind",
            source: "config/httpd.conf",
            target: "/usr/local/apache2/conf/httpd.conf",
            readOnly: true,
          },
          {
            type: "bind",
            source: "config/default.conf",
            target: "/usr/local/apache2/conf/extra/httpd-vhosts.conf",
            readOnly: true,
          },
        ],
      },
      kinds: ["rewritten", "rewritten"],
    },
    {
      name: "phpMyAdmin config mount",
      service: { type: "phpmyadmin:5", config: { config: "config/phpmyadmin.php" } },
      patch: {
        type: "phpmyadmin:5",
        mounts: [
          {
            type: "bind",
            source: "config/phpmyadmin.php",
            target: "/etc/phpmyadmin/config.user.inc.php",
            readOnly: true,
          },
        ],
      },
      kinds: ["rewritten"],
    },
    {
      name: "Solr config directory",
      service: { type: "solr:9", config: { dir: "config/solr" } },
      patch: { type: "solr:9", config: { dir: "config/solr" } },
      kinds: ["rewritten"],
    },
    {
      name: "internal SSL port",
      service: { type: "nginx", ssl: 3000, sslExpose: false },
      patch: { type: "nginx", certs: true, endpoints: [{ _tag: "internal", protocol: "https", port: 3000 }] },
      kinds: ["rewritten"],
    },
    {
      name: "published SSL port",
      service: { type: "nginx", ssl: 3000, sslExpose: true },
      patch: {
        type: "nginx",
        certs: true,
        endpoints: [{ _tag: "published", protocol: "https", port: 3000, publication: {} }],
      },
      kinds: ["rewritten"],
    },
    {
      name: "sport string",
      service: { type: "nginx", sport: "8443" },
      patch: { type: "nginx", certs: true, endpoints: [{ _tag: "internal", protocol: "https", port: 8443 }] },
      kinds: ["rewritten"],
    },
    {
      name: "sport overrides SSL port",
      service: { type: "nginx", ssl: 3000, sport: "8443", sslExpose: true },
      patch: {
        type: "nginx",
        certs: true,
        endpoints: [{ _tag: "published", protocol: "https", port: 8443, publication: {} }],
      },
      kinds: ["rewritten"],
    },
    {
      name: "enabled certificates",
      service: { type: "nginx", ssl: true },
      patch: { type: "nginx", certs: true },
      kinds: ["rewritten"],
    },
    {
      name: "disabled certificates",
      service: { type: "nginx", ssl: false },
      patch: { type: "nginx", certs: false },
      kinds: ["rewritten"],
    },
    {
      name: "environment list",
      service: { type: "node", environment: ["A=1", "B=x=y", "EMPTY="] },
      patch: { type: "node", environment: { A: "1", B: "x=y", EMPTY: "" } },
      kinds: [],
    },
    {
      name: "environment mapping",
      service: { type: "node", environment: { A: 1, B: false, EMPTY: "", OMIT: null } },
      patch: { type: "node", environment: { A: "1", B: "false", EMPTY: "" } },
      kinds: ["dropped"],
    },
    ...["cached", "delegated", "consistent"].map((app_mount) => ({
      name: `${app_mount} mount consistency`,
      service: { type: "node", app_mount },
      patch: { type: "node" },
      kinds: ["dropped"],
    })),
    ...[false, "disabled", "off"].map((app_mount) => ({
      name: `${app_mount} app mount`,
      service: { type: "node", app_mount },
      patch: { type: "node", appMount: false },
      kinds: ["rewritten"],
    })),
    {
      name: "direct common fields",
      service: { type: "node", command: ["npm", "start"], port: "3001", webroot: "public", user: "node" },
      patch: { type: "node", command: ["npm", "start"], port: 3001, webroot: "/app/public", user: "node" },
      kinds: ["rewritten"],
    },
    {
      name: "app-relative webroot with a leading current directory",
      service: { type: "php:8.3", webroot: "./web/" },
      patch: { type: "php:8.3", webroot: "/app/web" },
      kinds: ["rewritten"],
    },
    {
      name: "app-root webroot",
      service: { type: "php:8.3", webroot: "." },
      patch: { type: "php:8.3", webroot: "/app" },
      kinds: ["rewritten"],
    },
    {
      name: "container-absolute webroot",
      service: { type: "php:8.3", webroot: "/app/web" },
      patch: { type: "php:8.3", webroot: "/app/web" },
      kinds: [],
    },
    {
      name: "legacy path and scripts directory",
      service: { type: "node", path: ["/tools"], scriptsDir: "scripts" },
      patch: { type: "node" },
      kinds: ["dropped", "dropped"],
    },
    {
      name: "unowned options",
      service: {
        type: "php:8.3",
        overrides: { image: "custom" },
        build: ["true"],
        run: ["true"],
        via: "nginx",
        composer: "2",
        xdebug: true,
        db_client: "mysql",
        authentication: true,
        core: "main",
        mailFrom: [],
        password: "secret",
        persist: true,
        globals: {},
        hosts: [],
        backend: "app",
        backendPort: 80,
        maxMessages: 50,
        cores: [],
      },
      patch: { type: "php:8.3" },
      kinds: [],
    },
  ];

  test.each([...cases])("lowers $name when authored", ({ service, patch, kinds }) => {
    // Given the hand-authored service and service-relative context above.
    // When common catalog fields are lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then only the expected wire fields and diagnostics are emitted.
    expect(result.patch).toEqual(patch);
    expect(result.blocked).toBeUndefined();
    const actualKinds: readonly string[] = result.diagnostics.map((diagnostic) => diagnostic.kind);
    expect(actualKinds).toEqual(kinds);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.remediation?.trim().length).toBeGreaterThan(0);
      expect(diagnostic.keyPath.slice(0, 2)).toEqual([...ctx.keyPath]);
    }
  });

  test("mounts nginx-fronted PHP server files on the companion when via is nginx", () => {
    // Given PHP served by nginx with server and vhost files.
    const service = {
      type: "php:8.3",
      via: "nginx",
      config: { php: "config/php.ini", server: "config/nginx.conf", vhosts: "config/default.conf" },
    };
    // When common catalog fields are lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then PHP files stay on PHP and the web server files move to the companion.
    expect(result.patch.mounts).toEqual([
      {
        type: "bind",
        source: "config/php.ini",
        target: "/usr/local/etc/php/conf.d/zzz-lando-my-custom.ini",
        readOnly: true,
      },
    ]);
    expect(result.companions).toEqual({
      "app-nginx": {
        type: "nginx",
        mounts: [
          { type: "bind", source: "config/nginx.conf", target: "/etc/nginx/nginx.conf", readOnly: true },
          {
            type: "bind",
            source: "config/default.conf",
            target: "/etc/nginx/conf.d/default.conf",
            readOnly: true,
          },
        ],
      },
    });
  });

  test("renames mongo when the legacy alias is used", () => {
    // Given a supported legacy MongoDB alias.
    const service = { type: "mongo:7" };
    // When lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then the rename is explicit and reported exactly once.
    expect(result.patch).toEqual({ type: "mongodb:7" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "rewritten", keyPath: [...ctx.keyPath, "type"] });
    expect(result.diagnostics[0]?.message).toContain("mongo");
    expect(result.diagnostics[0]?.message).toContain("mongodb");
  });

  test.each(["memcached:1.6", "php"])("blocks %s when its version is unavailable", (type) => {
    // Given an unsupported or missing required version.
    const service = { type };
    // When lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then no replacement type or image is manufactured.
    expect(result.blocked).toBe(true);
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("unsupported");
    expect(result.diagnostics[0]?.message).toContain(type === "php" ? "unspecified" : "1.6");
    if (type === "php") expect(result.diagnostics[0]?.remediation).toContain("8.3");
  });

  test("exposes unknown resolution when the orchestrator must decide image fallback", () => {
    // Given an unknown type carrying an override owned by the caller.
    const service = { type: "frobnicator", overrides: { image: "custom:1" } };
    // When lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then the caller can distinguish this block and filter the diagnostic.
    expect(result.resolution).toEqual({ _tag: "unknown-type", id: "frobnicator" });
    expect(result.blocked).toBe(true);
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "unsupported", keyPath: [...ctx.keyPath, "type"] });
  });

  test("names the destination when PostgreSQL configuration is mapped", () => {
    // Given one mapped slot and an unknown slot.
    const service = {
      type: "postgres:16",
      config: { database: "config/postgresql.conf", unknown: "other.conf" },
    };
    // When lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then only the mapped slot survives, with an actionable destination.
    expect(result.patch).toEqual({ type: "postgres:16", config: { server: "config/postgresql.conf" } });
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.find((diagnostic) => diagnostic.kind === "rewritten")?.message).toContain(
      "/etc/lando/postgresql.conf",
    );
    expect(result.diagnostics.find((diagnostic) => diagnostic.kind === "dropped")?.keyPath).toEqual([
      ...ctx.keyPath,
      "config",
      "unknown",
    ]);
  });

  test.each([
    ["mem", "US-621C8"],
    ["plugins", "US-621C8"],
  ])("drops %s naming its pending story without blocking the service", (key, story) => {
    // Given an explicitly authored key whose Lando 4 target does not exist yet.
    const service = { type: "node", [key]: false };
    // When lowered.
    const result = lowerCatalogCommon(service, ctx);
    // Then the key is dropped, not marked unsupported, and the remediation names the pending target.
    expect(result.patch).toEqual({ type: "node" });
    expect(result.blocked).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "dropped", keyPath: [...ctx.keyPath, key] });
    expect(result.diagnostics[0]?.remediation).toContain(story);
  });

  test("drops moreHttpPorts with manual endpoint remediation", () => {
    // Given / When
    const result = lowerCatalogCommon({ type: "node", moreHttpPorts: ["8888"] }, ctx);
    // Then
    expect(result.patch).toEqual({ type: "node" });
    expect(result.blocked).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "dropped",
      keyPath: [...ctx.keyPath, "moreHttpPorts"],
    });
    expect(result.diagnostics[0]?.remediation).toContain("endpoint");
    expect(result.diagnostics[0]?.remediation).not.toMatch(/US-\d/u);
  });

  test("rewrites meUser as the service user", () => {
    // Given / When
    const result = lowerCatalogCommon({ type: "node", meUser: "node" }, ctx);
    // Then
    expect(result.patch).toEqual({ type: "node", user: "node" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: "rewritten",
        keyPath: [...ctx.keyPath, "meUser"],
        message: "Rewrote meUser as the service user.",
      }),
    ]);
  });
});
