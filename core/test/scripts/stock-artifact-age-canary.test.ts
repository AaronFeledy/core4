import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serviceTypes } from "@lando/service-lando";
import { runStockArtifactAgeCanary } from "../../../scripts/stock-artifact-age-canary.ts";
import { makeStockArtifactLookup } from "../../../scripts/stock-artifact-registry.ts";

const now = Date.parse("2026-11-19T00:00:00Z");
const ninetyDaysAgo = Date.parse("2026-08-21T00:00:00Z");
const dockerTagUrl = (repo: string, tag: string) =>
  `https://hub.docker.com/v2/repositories/${repo}/tags/${tag}`;

test("reports every runtime artifact reference, including Node and pinned Tomcat", async () => {
  const rows = await runStockArtifactAgeCanary({ now: () => now, deadlineMs: now });
  const references = rows.map(({ tag }) => tag);
  const expectedCatalogRefs = [...serviceTypes.values()].flatMap(({ artifacts }) =>
    Object.values(artifacts ?? {}),
  );
  expect(references).toEqual(expect.arrayContaining(expectedCatalogRefs));
  expect(new Set(references).size).toBe(references.length);
  expect(references.some((ref) => /^node:/u.test(ref))).toBe(true);
  expect(references.some((ref) => /^tomcat:.*@sha256:/u.test(ref))).toBe(true);
  expect(references.some((ref) => /^docker\.elastic\.co\/elasticsearch\//u.test(ref))).toBe(true);
});

test("reports unversioned service defaults and all three stock PHP image modes", async () => {
  const rows = await runStockArtifactAgeCanary({ now: () => now, deadlineMs: now });
  const repos = new Set(rows.map(({ tag }) => tag.split(":")[0]));
  for (const repo of [
    "caddy",
    "nginx",
    "httpd",
    "localstack/localstack",
    "mailhog/mailhog",
    "docker.io/axllent/mailpit",
    "memcached",
    "valkey/valkey",
  ]) {
    expect(repos.has(repo)).toBe(true);
  }
  const phpTags = rows.flatMap(({ tag }) => (tag.startsWith("php:") ? [tag] : []));
  const apache = phpTags.filter((tag) => tag.includes("-apache-"));
  expect(apache.length).not.toBe(0);
  expect(phpTags.sort()).toEqual(
    apache.flatMap((tag) => [tag, tag.replace("-apache-", "-fpm-"), tag.replace("-apache-", "-cli-")]).sort(),
  );
});

test.each([
  { lastUpdated: new Date(ninetyDaysAgo).toISOString(), verdict: "fresh" },
  { lastUpdated: new Date(ninetyDaysAgo - 1).toISOString(), verdict: "stale" },
  { lastUpdated: "not a date", verdict: "unknown" },
  { lastUpdated: "0001-01-01T00:00:00Z", verdict: "unknown" },
  { lastUpdated: undefined, verdict: "unknown" },
])("classifies a Hub tag with last_updated=$lastUpdated as $verdict", async ({ lastUpdated, verdict }) => {
  const lookup = makeStockArtifactLookup({
    now: () => now,
    fetch: async (url) =>
      url === dockerTagUrl("library/example", "1")
        ? Response.json({ last_updated: lastUpdated }, { headers: { Date: new Date(now).toUTCString() } })
        : new Response(null, { status: 404 }),
  });
  expect((await lookup("registry-1.docker.io/example:1")).verdict).toBe(verdict);
});

test("reads a non-Hub manifest and image config, not the HTTP Date header", async () => {
  const base = "https://registry.example.com/v2/acme";
  const config = `sha256:${"2".repeat(64)}`;
  const created = "2026-05-01T00:00:00.000000000Z";
  const lookup = makeStockArtifactLookup({
    now: () => now,
    fetch: async (url) => {
      const headers = { Date: new Date(now).toUTCString() };
      if (url === `${base}/example/manifests/1`)
        return Response.json({ config: { digest: config } }, { headers });
      if (url === `${base}/example/blobs/${config}`) return Response.json({ created }, { headers });
      return new Response(null, { status: 404 });
    },
  });
  expect(await lookup("registry.example.com/acme/example:1")).toMatchObject({
    verdict: "stale",
    source: "registry-config-created",
    rebuiltAtMs: Date.parse(created),
  });
});

test("authenticates a pinned Hub lookup and dates the amd64 config, not the mutable tag", async () => {
  const pinned = `sha256:${"0".repeat(64)}`;
  const child = `sha256:${"1".repeat(64)}`;
  const alternate = `sha256:${"a".repeat(64)}`;
  const config = `sha256:${"2".repeat(64)}`;
  const ref = `example:1@${pinned}`;
  const base = "https://registry-1.docker.io/v2/library/example";
  const responses = new Map([
    [
      `${base}/manifests/${pinned}`,
      {
        manifests: [
          { digest: alternate, platform: { os: "linux", architecture: "arm64" } },
          { digest: child, platform: { os: "linux", architecture: "amd64" } },
        ],
      },
    ],
    [`${base}/manifests/${child}`, { config: { digest: config } }],
    [`${base}/blobs/${config}`, { created: "2026-01-01T00:00:00Z" }],
  ]);
  const lookup = makeStockArtifactLookup({
    now: () => now,
    fetch: async (url, init) => {
      if (url === dockerTagUrl("library/example", "1"))
        return Response.json({ last_updated: "2026-11-18T00:00:00Z" });
      if (
        url ===
        "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fexample%3Apull"
      ) {
        return Response.json({ token: "test-token" });
      }
      if (!responses.has(url)) return new Response(null, { status: 404 });
      if (new Headers(init.headers).get("Authorization") !== "Bearer test-token") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/example:pull"',
          },
        });
      }
      return Response.json(responses.get(url));
    },
  });
  expect(await lookup(ref)).toMatchObject({ tag: ref, verdict: "stale", source: "registry-config-created" });
});

test("keeps an unavailable pinned manifest unknown rather than dating its mutable tag", async () => {
  const ref = `example:1@sha256:${"0".repeat(64)}`;
  const lookup = makeStockArtifactLookup({
    now: () => now,
    fetch: async (url) =>
      url === dockerTagUrl("library/example", "1")
        ? Response.json({ last_updated: "2026-11-18T00:00:00Z" })
        : Response.json({}, { status: 404, headers: { Date: new Date(now).toUTCString() } }),
  });
  expect(await lookup(ref)).toMatchObject({ tag: ref, verdict: "unknown" });
});

test("retries a rate-limited lookup after Retry-After, then leaves it unknown", async () => {
  const sleeps: number[] = [];
  const lookup = makeStockArtifactLookup({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: async (url) =>
      new Response(
        null,
        url === dockerTagUrl("acme/example", "1")
          ? { status: 429, headers: { "retry-after": "2" } }
          : { status: 404 },
      ),
  });
  expect(await lookup("acme/example:1")).toMatchObject({ verdict: "unknown", detail: "Docker Hub HTTP 429" });
  expect(sleeps).toEqual([2_000]);
});

test("transport failures are unknown", async () => {
  const lookup = makeStockArtifactLookup({
    now: () => now,
    sleep: async () => undefined,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  expect(await lookup("acme/example:1")).toMatchObject({ verdict: "unknown" });
});

test("all remaining image lookups share the same deadline", async () => {
  let current = now;
  let fetches = 0;
  const rows = await runStockArtifactAgeCanary({
    now: () => current,
    deadlineMs: now + 50,
    fetch: async () => {
      fetches++;
      current += 50;
      return Response.json({ last_updated: "2026-11-18T00:00:00Z" });
    },
  });
  expect(fetches).toBe(1);
  expect(rows[0]?.verdict).toBe("fresh");
  expect(new Set(rows.slice(1).map(({ verdict }) => verdict))).toEqual(new Set(["unknown"]));
});

test("the CLI reports stale and unknown ages without failing, even if the summary cannot be written", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-stock-artifact-canary-"));
  try {
    const preload = join(root, "fake-registry.ts");
    const script = resolve(import.meta.dirname, "../../../scripts/stock-artifact-age-canary.ts");
    const summary = join(root, "summary.md");
    await Bun.write(
      preload,
      `globalThis.fetch = async (url) => String(url).startsWith("https://hub.docker.com/")
        ? Response.json({ last_updated: "2020-01-01T00:00:00Z" })
        : new Response(null, { status: 404 });`,
    );
    const run = async (path: string) => {
      const child = Bun.spawn([process.execPath, "--preload", preload, script], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: path },
        stdout: "pipe",
        stderr: "inherit",
      });
      const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(status).toBe(0);
      return stdout;
    };
    const stdout = await run(summary);
    expect(stdout).toContain("::warning title=Stale stock image::");
    expect(stdout).toContain("::warning title=Unknown stock image age::");
    const markdown = await Bun.file(summary).text();
    expect(markdown).toMatch(/## Stale \([1-9]\d*\)/u);
    expect(markdown).toMatch(/## Unknown \([1-9]\d*\)/u);
    expect(stdout).toContain(markdown);
    expect(await run(root)).toContain("::warning title=Stock artifact age canary summary::");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
