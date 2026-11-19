import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STALE_AFTER_MS,
  classifyTagAge,
  extractStockArtifactTags,
  extractStockArtifactTagsFromDirectory,
  extractStockArtifactTagsFromFiles,
  formatCanarySummary,
  hubTagUrl,
  lookupTagRebuild,
  parseRebuildTimestamp,
  parseStockImageRef,
  registryManifestUrl,
} from "../../../scripts/stock-artifact-age-canary.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "stock-artifact-age-"));
  roots.push(root);
  return root;
};

test("extracts literal artifact tables and default image constants", () => {
  const tags = extractStockArtifactTags(`
    const DEFAULT_IMAGE = "mysql:8.0";
    export const MYSQL_ARTIFACTS = {
      "8.0": DEFAULT_IMAGE,
      "8.4": "mysql:8.4",
    } as const;
    const IMAGE = "adminer:6";
    export const type = {
      artifacts: { "6": IMAGE },
    };
    const MAILHOG_IMAGE = "mailhog/mailhog:v1.0.1";
    export const STATIC_SERVER_IMAGES = { nginx: "nginx:1.26-alpine", caddy: "caddy:2-alpine" };
  `);
  expect(tags).toEqual([
    "adminer:6",
    "caddy:2-alpine",
    "mailhog/mailhog:v1.0.1",
    "mysql:8.0",
    "mysql:8.4",
    "nginx:1.26-alpine",
  ]);
});

test("does not treat service type ids or non-image artifacts as stock tags", () => {
  const tags = extractStockArtifactTags(`
    const typeId = "php:8.3";
    export const PHP_MONGOSH_RELEASE = {
      artifacts: {
        amd64: { url: "https://example.invalid/mongodb-mongosh.deb", sha256: "abc" },
      },
    };
    const ARTIFACTS = { "8": "php:8.3-apache-bookworm" } as const;
  `);
  expect(tags).toEqual(["php:8.3-apache-bookworm"]);
});

test("expands Object.fromEntries artifact tables and phpImageFor", () => {
  const files = new Map([
    [
      "/fixture/php.ts",
      `
        import { phpImageFor, SUPPORTED_PHP_VERSIONS } from "./php-via.ts";
        const PHP_ARTIFACTS = Object.fromEntries(
          SUPPORTED_PHP_VERSIONS.map((version) => [version, phpImageFor(version, "apache")]),
        );
        const GO_ARTIFACTS = Object.fromEntries(
          (["1.22", "1.23"] as const).map((version) => [version, \`golang:\${version}\`]),
        );
      `,
    ],
    [
      "/fixture/php-via.ts",
      `
        export const SUPPORTED_PHP_VERSIONS = ["8.3", "8.6"] as const;
        const phpUpstreamVersion = (version: string): string => (version === "8.6" ? "8.6-rc" : version);
        export const phpImageFor = (version: string, via: string): string =>
          \`php:\${phpUpstreamVersion(version)}-\${via}-bookworm\`;
      `,
    ],
  ]);
  expect(extractStockArtifactTagsFromFiles(files)).toEqual([
    "golang:1.22",
    "golang:1.23",
    "php:8.3-apache-bookworm",
    "php:8.6-rc-apache-bookworm",
  ]);
});

test("resolves catalog image fields referenced by artifact tables", () => {
  const files = new Map([
    [
      "/fixture/tomcat.ts",
      `
        import { TOMCAT_CATALOG } from "./generated/tomcat-catalog.ts";
        const ARTIFACTS = {
          "9": TOMCAT_CATALOG["9"].image,
        } as const;
      `,
    ],
    [
      "/fixture/generated/tomcat-catalog.ts",
      `
        export const TOMCAT_CATALOG = {
          "9": { image: "tomcat:9.0.123-jre21@sha256:${"a".repeat(64)}" },
        } as const;
      `,
    ],
  ]);
  expect(extractStockArtifactTagsFromFiles(files)).toEqual(["tomcat:9.0.123-jre21"]);
});

test("reads a services directory and follows relative image constant imports", async () => {
  const root = await fixtureRoot();
  await mkdir(join(root, "services"), { recursive: true });
  await writeFile(
    join(root, "services", "valkey.ts"),
    'const DEFAULT_IMAGE = "valkey/valkey:8";\nexport const VALKEY_IMAGE = DEFAULT_IMAGE;\n',
  );
  await writeFile(
    join(root, "services", "localstack.ts"),
    'const DEFAULT_IMAGE = "localstack/localstack:4.14.0";\n',
  );
  await writeFile(
    join(root, "services", "elasticsearch.ts"),
    'const DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.17.0";\nconst ARTIFACTS = { "8": DEFAULT_IMAGE } as const;\n',
  );
  await writeFile(
    join(root, "mailpit-constants.ts"),
    'export const MAILPIT_IMAGE = "docker.io/axllent/mailpit:v1.30.1";\n',
  );
  await writeFile(
    join(root, "services", "mailpit.ts"),
    'import { MAILPIT_IMAGE } from "../mailpit-constants.ts";\nexport const keep = MAILPIT_IMAGE;\n',
  );
  expect(await extractStockArtifactTagsFromDirectory(join(root, "services"))).toEqual([
    "docker.elastic.co/elasticsearch/elasticsearch:8.17.0",
    "docker.io/axllent/mailpit:v1.30.1",
    "localstack/localstack:4.14.0",
    "valkey/valkey:8",
  ]);
});

const requireParsedRef = (value: string) => {
  const parsed = parseStockImageRef(value);
  if (parsed === undefined) throw new TypeError(`expected image ref ${value}`);
  return parsed;
};

test("builds portable Hub and registry lookup URLs", () => {
  expect(hubTagUrl(requireParsedRef("mysql:8.0"))).toBe(
    "https://hub.docker.com/v2/repositories/library/mysql/tags/8.0",
  );
  expect(hubTagUrl(requireParsedRef("valkey/valkey:8"))).toBe(
    "https://hub.docker.com/v2/repositories/valkey/valkey/tags/8",
  );
  expect(hubTagUrl(requireParsedRef("getmeili/meilisearch:v1.11"))).toBe(
    "https://hub.docker.com/v2/repositories/getmeili/meilisearch/tags/v1.11",
  );
  expect(hubTagUrl(requireParsedRef("docker.io/axllent/mailpit:v1.30.1"))).toBe(
    "https://hub.docker.com/v2/repositories/axllent/mailpit/tags/v1.30.1",
  );
  expect(hubTagUrl(requireParsedRef("mailhog/mailhog:v1.0.1"))).toBe(
    "https://hub.docker.com/v2/repositories/mailhog/mailhog/tags/v1.0.1",
  );
  expect(hubTagUrl(requireParsedRef("opensearchproject/opensearch:2"))).toBe(
    "https://hub.docker.com/v2/repositories/opensearchproject/opensearch/tags/2",
  );
  expect(hubTagUrl(requireParsedRef("localstack/localstack:4.14.0"))).toBe(
    "https://hub.docker.com/v2/repositories/localstack/localstack/tags/4.14.0",
  );
  const elastic = requireParsedRef("docker.elastic.co/elasticsearch/elasticsearch:8.17.0");
  expect(hubTagUrl(elastic)).toBeUndefined();
  expect(registryManifestUrl(elastic)).toBe(
    "https://docker.elastic.co/v2/elasticsearch/elasticsearch/manifests/8.17.0",
  );
  expect(hubTagUrl(requireParsedRef("mcr.microsoft.com/mssql/server:2019-latest"))).toBeUndefined();
});

test("classifies fresh, stale, and unknown rebuild ages", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  expect(classifyTagAge(now - STALE_AFTER_MS, now)).toBe("fresh");
  expect(classifyTagAge(now - STALE_AFTER_MS - 1, now)).toBe("stale");
  expect(classifyTagAge(now, now)).toBe("fresh");
  expect(classifyTagAge(undefined, now)).toBe("unknown");
  expect(parseRebuildTimestamp("not-a-date")).toBeUndefined();
  expect(parseRebuildTimestamp("0001-01-01T00:00:00Z")).toBeUndefined();
});

test("Hub last_updated is used and HTTP Date is ignored", async () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const stale = Date.parse("2026-01-01T00:00:00Z");
  const hub = await lookupTagRebuild("mysql:8.0", {
    nowMs: now,
    sleep: async () => undefined,
    fetch: async () =>
      Response.json(
        { last_updated: "2026-01-01T00:00:00.000000Z" },
        { headers: { Date: "Wed, 19 Nov 2026 00:00:00 GMT" } },
      ),
  });
  expect(hub).toMatchObject({
    verdict: "stale",
    source: "hub-last-updated",
    rebuiltAtMs: stale,
  });

  const missing = await lookupTagRebuild("mysql:8.0", {
    nowMs: now,
    sleep: async () => undefined,
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { Date: "Wed, 19 Nov 2026 00:00:00 GMT", "content-type": "application/json" },
      }),
  });
  expect(missing.verdict).toBe("unknown");
  expect(missing.source).toBe("unknown");
});

test("non-Hub registries use config created and never the Date header", async () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const created = "2026-10-01T00:00:00.000000000Z";
  const fetchImpl = async (url: string) => {
    if (url.endsWith("/manifests/8.17.0")) {
      return Response.json(
        { schemaVersion: 2, config: { digest: "sha256:abc" } },
        { headers: { Date: "Wed, 01 Jan 2020 00:00:00 GMT" } },
      );
    }
    if (url.endsWith("/blobs/sha256:abc")) {
      return Response.json({ created }, { headers: { Date: "Wed, 01 Jan 2020 00:00:00 GMT" } });
    }
    return new Response("missing", { status: 404 });
  };
  const lookup = await lookupTagRebuild("docker.elastic.co/elasticsearch/elasticsearch:8.17.0", {
    nowMs: now,
    sleep: async () => undefined,
    fetch: fetchImpl,
  });
  expect(lookup).toMatchObject({
    verdict: "fresh",
    source: "registry-config-created",
    rebuiltAt: "2026-10-01T00:00:00.000Z",
  });

  const unknown = await lookupTagRebuild("docker.elastic.co/elasticsearch/elasticsearch:8.17.0", {
    nowMs: now,
    sleep: async () => undefined,
    fetch: async (url: string) => {
      if (url.endsWith("/manifests/8.17.0")) {
        return new Response("{}", {
          status: 200,
          headers: { Date: "Wed, 19 Nov 2026 00:00:00 GMT", "content-type": "application/json" },
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
  expect(unknown.verdict).toBe("unknown");
  expect(unknown.detail).toBe("registry config digest missing");
});

test("retries HTTP 429 then warns unknown, never treating a failed lookup as fresh", async () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const sleeps: number[] = [];
  let hits = 0;
  const lookup = await lookupTagRebuild("mysql:8.0", {
    nowMs: now,
    attempts: 3,
    baseDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async () => {
      hits += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    },
  });
  expect(hits).toBe(3);
  expect(sleeps).toEqual([1000, 1000]);
  expect(lookup.verdict).toBe("unknown");
  expect(lookup.detail).toBe("hub HTTP 429");

  const failed = await lookupTagRebuild("mysql:8.0", {
    nowMs: now,
    attempts: 2,
    baseDelayMs: 1,
    sleep: async () => undefined,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  expect(failed.verdict).toBe("unknown");
  expect(failed.source).toBe("unknown");
});

test("summary lists stale and unknown tags", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const markdown = formatCanarySummary(
    [
      {
        tag: "mysql:8.0",
        rebuiltAt: "2026-01-01T00:00:00.000Z",
        rebuiltAtMs: Date.parse("2026-01-01T00:00:00Z"),
        verdict: "stale",
        source: "hub-last-updated",
        detail: "Docker Hub last_updated",
      },
      {
        tag: "docker.elastic.co/elasticsearch/elasticsearch:8.17.0",
        rebuiltAt: undefined,
        rebuiltAtMs: undefined,
        verdict: "unknown",
        source: "unknown",
        detail: "registry config created missing",
      },
      {
        tag: "redis:7",
        rebuiltAt: "2026-11-01T00:00:00.000Z",
        rebuiltAtMs: Date.parse("2026-11-01T00:00:00Z"),
        verdict: "fresh",
        source: "hub-last-updated",
        detail: "Docker Hub last_updated",
      },
    ],
    now,
  );
  expect(markdown).toContain("## Stale");
  expect(markdown).toContain("`mysql:8.0`");
  expect(markdown).toContain("## Unknown");
  expect(markdown).toContain("`docker.elastic.co/elasticsearch/elasticsearch:8.17.0`");
  expect(markdown).toContain("registry config created missing");
  expect(markdown).not.toContain("`redis:7`");
  expect(markdown).toContain("ARTIFACT_REFRESH_EXTENSION");
  expect(markdown).toContain("refresh:true");
});

test("extracts stock tags from the live service-lando artifact tables", async () => {
  const tags = await extractStockArtifactTagsFromDirectory(
    resolve(import.meta.dirname, "../../../plugins/service-lando/src/services"),
  );
  expect(tags).toContain("mysql:8.0");
  expect(tags).toContain("valkey/valkey:8");
  expect(tags).toContain("getmeili/meilisearch:v1.11");
  expect(tags).toContain("localstack/localstack:4.14.0");
  expect(tags).toContain("mailhog/mailhog:v1.0.1");
  expect(tags).toContain("opensearchproject/opensearch:2");
  expect(tags).toContain("docker.elastic.co/elasticsearch/elasticsearch:8.17.0");
  expect(tags).toContain("php:8.3-apache-bookworm");
  expect(tags).not.toContain("php:8.3");
  expect(tags.length).toBeGreaterThan(20);
});
