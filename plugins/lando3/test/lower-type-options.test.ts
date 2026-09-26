import { describe, expect, it } from "bun:test";
import { lowerTypeOptions } from "../src/lower-type-options.ts";
import { type ServiceLoweringContext, emptyPatch } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "example",
  keyPath: ["services", "example"],
  fallbackSourceId: "primary",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

const diagnostic = (kind: string, key: string) =>
  expect.objectContaining({
    kind,
    keyPath: ["services", "example", key],
    sourceId: "primary",
    message: expect.stringMatching(/\S/),
    remediation: expect.stringMatching(/\S/),
  });

describe("lowerTypeOptions", () => {
  for (const catalogId of ["mysql", "mariadb"]) {
    it(`writes authentication into 99-lando.cnf when ${catalogId} sets authentication`, () => {
      // Given
      const service = { authentication: "mysql_native_password" };
      // When
      const result = lowerTypeOptions(catalogId, service, ctx);
      // Then
      const directive = "default_authentication_plugin=mysql_native_password";
      expect(result.diagnostics).toEqual([diagnostic("rewritten", "authentication")]);
      expect(result.patch).toEqual({
        build: {
          artifact: [
            {
              user: "root",
              run: `mkdir -p /etc/mysql/conf.d && printf '%s\\n' '[mysqld]' '${directive}' > /etc/mysql/conf.d/99-lando.cnf`,
            },
          ],
        },
      });
    });
  }

  it("rejects an authentication value that is not an identifier", () => {
    // Given
    const service = { authentication: "mysql;touch" };
    // When
    const result = lowerTypeOptions("mysql", service, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toEqual([diagnostic("unsupported", "authentication")]);
  });

  const cases = [
    {
      name: "Solr core",
      id: "solr",
      service: { core: "solo" },
      patch: { cores: ["solo"] },
      diagnostics: [diagnostic("rewritten", "core")],
    },
    {
      name: "Solr cores",
      id: "solr",
      service: { cores: ["a", "b"] },
      patch: { cores: ["a", "b"] },
      diagnostics: [],
    },
    {
      name: "Mailpit message limit",
      id: "mailpit",
      service: { mailFrom: ["appserver"], maxMessages: 54321 },
      patch: { mailFrom: ["appserver"], environment: { MP_MAX_MESSAGES: "54321" } },
      diagnostics: [diagnostic("rewritten", "maxMessages")],
    },
    {
      name: "MailHog alias",
      id: "mailhog",
      service: { hogfrom: ["appserver"] },
      patch: { mailFrom: ["appserver"] },
      diagnostics: [diagnostic("rewritten", "hogfrom")],
    },
    {
      name: "sendFrom string",
      id: "mailpit",
      service: { sendFrom: "appserver" },
      patch: { mailFrom: ["appserver"] },
      diagnostics: [diagnostic("rewritten", "sendFrom")],
    },
    {
      name: "mailFrom string",
      id: "mailpit",
      service: { mailFrom: "appserver" },
      patch: { mailFrom: ["appserver"] },
      diagnostics: [],
    },
    {
      name: "disabled mail routing",
      id: "mailpit",
      service: { mailFrom: false },
      patch: { mailFrom: false },
      diagnostics: [],
    },
    {
      name: "disabled alias",
      id: "mailhog",
      service: { hogfrom: false },
      patch: { mailFrom: false },
      diagnostics: [diagnostic("rewritten", "hogfrom")],
    },
    {
      name: "Redis options",
      id: "redis",
      service: { password: "nerfherder", persist: true },
      patch: { password: "nerfherder", persist: true },
      diagnostics: [],
    },
    {
      name: "Redis persistence disabled",
      id: "redis",
      service: { persist: false },
      patch: { persist: false },
      diagnostics: [],
    },
    {
      name: "Node globals",
      id: "node",
      service: { globals: { pnpm: "latest-10", yarn: "1.22.4" } },
      patch: { globals: { pnpm: "latest-10", yarn: "1.22.4" } },
      diagnostics: [diagnostic("rewritten", "globals")],
    },
    {
      name: "numeric global version",
      id: "node",
      service: { globals: { pnpm: 10 } },
      patch: { globals: { pnpm: "10" } },
      diagnostics: [diagnostic("rewritten", "globals")],
    },
    {
      name: "phpMyAdmin hosts",
      id: "phpmyadmin",
      service: { hosts: ["database", "mariadb"] },
      patch: { hosts: ["database", "mariadb"] },
      diagnostics: [],
    },
    {
      name: "phpMyAdmin host string",
      id: "phpmyadmin",
      service: { hosts: "database" },
      patch: { hosts: ["database"] },
      diagnostics: [],
    },
    {
      name: "Varnish single backend",
      id: "varnish",
      service: { backends: ["appserver"], backend: "appserver", backend_port: 8000 },
      patch: { backend: "appserver" },
      diagnostics: [diagnostic("rewritten", "backends"), diagnostic("dropped", "backend_port")],
    },
    {
      name: "Varnish canonical backend",
      id: "varnish",
      service: { backend: "appserver" },
      patch: { backend: "appserver" },
      diagnostics: [],
    },
    {
      name: "nginx webroot",
      id: "nginx",
      service: { webroot: "public" },
      patch: { webroot: "/app/public" },
      diagnostics: [],
    },
    {
      name: "Apache options",
      id: "apache",
      service: { webroot: ".", allowOverride: false },
      patch: { webroot: "/app", allowOverride: false },
      diagnostics: [],
    },
  ];

  for (const entry of cases) {
    it(`lowers options when given ${entry.name}`, () => {
      // Given
      const { id, service, patch, diagnostics } = entry;
      // When
      const result = lowerTypeOptions(id, service, ctx);
      // Then
      expect(result).toEqual({ patch, diagnostics });
    });
  }

  it("blocks conversion when Varnish has multiple backends", () => {
    // Given
    const service = { backends: ["a", "b"] };
    // When
    const result = lowerTypeOptions("varnish", service, ctx);
    // Then
    expect(result).toEqual({
      patch: {},
      blocked: true,
      diagnostics: [diagnostic("unsupported", "backends")],
    });
  });

  it("returns an empty patch when the catalog id has no option lowerer", () => {
    // Given
    const service = { webroot: "." };
    // When
    const result = lowerTypeOptions("tomcat", service, ctx);
    // Then
    expect(result).toEqual(emptyPatch);
  });

  for (const id of [
    "mysql",
    "mariadb",
    "solr",
    "mailpit",
    "mailhog",
    "redis",
    "node",
    "phpmyadmin",
    "varnish",
    "nginx",
    "apache",
  ]) {
    it(`ignores other lowerers' keys when processing ${id}`, () => {
      // Given
      const service = {
        type: id,
        port: 8025,
        portforward: true,
        ssl: true,
        config: {},
        environment: { KEEP: "value" },
        creds: {},
        overrides: {},
        build: ["true"],
        run: ["true"],
        via: "nginx",
        composer: {},
        xdebug: true,
        db_client: true,
      };
      // When
      const result = lowerTypeOptions(id, service, ctx);
      // Then
      expect(result).toEqual(emptyPatch);
    });
  }
});
