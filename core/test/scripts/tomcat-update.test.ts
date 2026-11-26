import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOMCAT_MAJORS, TomcatUpdateError, sha256 } from "../../../scripts/tomcat-config.ts";
import type { TomcatFetch } from "../../../scripts/tomcat-registry.ts";
import {
  type TomcatSnapshot,
  prepareTomcatUpdate,
  readTomcatSnapshot,
  reportTomcatUpdate,
  updateTomcat,
} from "../../../scripts/update-tomcat.ts";
import {
  type RegistryFailure,
  rebuildFixtureImage,
  tomcatRegistryFixture,
} from "./support/tomcat-registry-fixture.ts";

const writeSnapshot = async (directory: string, snapshot: TomcatSnapshot) => {
  await Bun.write(join(directory, "pins.json"), `${JSON.stringify(snapshot.pins, null, 2)}\n`);
  for (const major of TOMCAT_MAJORS)
    await Bun.write(join(directory, `server-${major}.xml`), snapshot.configs[major]);
};

describe("paired Tomcat updater", () => {
  const redirectBlobsTo = (
    fixture: Awaited<ReturnType<typeof tomcatRegistryFixture>>,
    host: string,
    serve: (body: string) => string = (body) => body,
  ) => {
    const storage = new Map<string, string>();
    const storageHeaders: RequestInit["headers"][] = [];
    const request: TomcatFetch = async (url, init) => {
      if (url.startsWith("https://registry-1.docker.io/v2/library/tomcat/blobs/")) {
        const location = `https://${host}/${sha256(url)}`;
        storage.set(location, serve(await (await fixture.request(url, init)).text()));
        return new Response(null, { status: 307, headers: { location } });
      }
      if (url.startsWith(`https://${host}/`)) {
        storageHeaders.push(init?.headers);
        return new Response(storage.get(url));
      }
      return fixture.request(url, init);
    };
    return { request, storageHeaders };
  };

  test.each([
    "production.cloudfront.docker.com",
    "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  ])("follows a Docker blob storage redirect to %s without forwarding registry credentials", async (host) => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const { request, storageHeaders } = redirectBlobsTo(fixture, host);
    // When
    const result = await prepareTomcatUpdate(fixture.snapshot, request);
    // Then
    expect(result).toEqual(fixture.snapshot);
    expect(storageHeaders).toHaveLength(6);
    expect(storageHeaders.every((headers) => headers === undefined)).toBe(true);
  });

  test("rejects a redirected blob whose bytes do not match the registry digest", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const { request } = redirectBlobsTo(fixture, "storage.example", (body) => `${body} `);
    // When / Then
    await expect(prepareTomcatUpdate(fixture.snapshot, request)).rejects.toThrow(
      "registry digest/body mismatch",
    );
  });

  test.each([
    ["http://storage.example/blob", "http://storage.example"],
    ["https://storage.example:8443/blob", "https://storage.example:8443"],
    ["https://user:secret@storage.example/blob", "https://storage.example"],
    ["not a url", "a missing or invalid location"],
  ])("rejects the registry blob redirect %s before requesting it", async (location, destination) => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const requested: string[] = [];
    const request: TomcatFetch = async (url, init) => {
      requested.push(url);
      return url.includes("/blobs/")
        ? new Response(null, { status: 307, headers: { location } })
        : fixture.request(url, init);
    };
    // When
    const failure = await prepareTomcatUpdate(fixture.snapshot, request).catch((error: unknown) => error);
    // Then
    expect(failure).toBeInstanceOf(TomcatUpdateError);
    expect(String(failure)).toEndWith(`unsafe registry blob redirect to ${destination}`);
    expect(requested.some((url) => url.includes("storage.example"))).toBe(false);
  });

  test("sends the GitHub token only to the GitHub API", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    // When
    await prepareTomcatUpdate(fixture.snapshot, fixture.request, "github-test-token");
    // Then
    const authorized = fixture.authorizations.filter(([, value]) => value === "Bearer github-test-token");
    expect(authorized.map(([url]) => new URL(url).host)).toEqual(Array(6).fill("api.github.com"));
    expect(authorized.some(([url]) => url.includes("/contents/conf/server.xml?ref="))).toBe(true);
  });

  test("names the GitHub token when unauthenticated API requests are refused", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const request: TomcatFetch = async (url, init) =>
      url.startsWith("https://api.github.com/")
        ? new Response("rate limited", { status: 403 })
        : fixture.request(url, init);
    // When / Then
    await expect(prepareTomcatUpdate(fixture.snapshot, request)).rejects.toThrow(
      "Apache tag provenance: HTTP 403; set GITHUB_TOKEN or GH_TOKEN",
    );
  });

  test("prepares a new patch version with the release-matched baseline", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const previous = {
      ...fixture.snapshot,
      pins: {
        ...fixture.snapshot.pins,
        majors: {
          ...fixture.snapshot.pins.majors,
          "9": { ...fixture.snapshot.pins.majors["9"], version: "9.0.122" },
        },
      },
    };
    // When
    const candidate = await prepareTomcatUpdate(previous, fixture.request);
    // Then
    expect(candidate.pins.majors["9"]).toEqual(fixture.snapshot.pins.majors["9"]);
    expect(candidate.configs["9"]).toBe(fixture.snapshot.configs["9"]);
  });
  test("is a no-op when all paired inputs remain current", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const directory = await mkdtemp(join(tmpdir(), "tomcat-noop-"));
    try {
      await writeSnapshot(directory, fixture.snapshot);
      // When
      const result = await updateTomcat(directory, fixture.request);
      // Then
      expect(result.changed).toBe(false);
      expect(await readTomcatSnapshot(directory)).toEqual(fixture.snapshot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("pairs a rebuilt same-version image index with its matching baseline", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    rebuildFixtureImage(fixture, "10");
    const directory = await mkdtemp(join(tmpdir(), "tomcat-rebuild-"));
    try {
      await writeSnapshot(directory, fixture.snapshot);
      // When
      const result = await updateTomcat(directory, fixture.request);
      const candidate = await readTomcatSnapshot(directory);
      // Then
      expect(result.changed).toBe(true);
      expect(candidate.pins.majors["10"].indexDigest).not.toBe(
        fixture.snapshot.pins.majors["10"].indexDigest,
      );
      expect(candidate.pins.majors["10"].version).toBe(fixture.snapshot.pins.majors["10"].version);
      expect(candidate.configs).toEqual(fixture.snapshot.configs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    "digest",
    "platform",
    "version",
    "shape",
    "network",
    "exact",
    "blob",
  ] satisfies readonly RegistryFailure[])(
    "preserves every previous file when candidate validation fails: %s",
    async (failure) => {
      // Given
      const valid = await tomcatRegistryFixture();
      const invalid = await tomcatRegistryFixture(failure);
      const directory = await mkdtemp(join(tmpdir(), "tomcat-invalid-"));
      try {
        await writeSnapshot(directory, valid.snapshot);
        const paths = ["pins.json", ...TOMCAT_MAJORS.map((major) => `server-${major}.xml`)];
        const before = await Promise.all(paths.map((path) => Bun.file(join(directory, path)).text()));
        // When / Then
        await expect(updateTomcat(directory, invalid.request)).rejects.toThrow();
        expect(await Promise.all(paths.map((path) => Bun.file(join(directory, path)).text()))).toEqual(
          before,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("rejects a damaged local baseline before preparing a replacement", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const damaged = { ...fixture.snapshot, configs: { ...fixture.snapshot.configs, "9": "<Server/>" } };
    // When / Then
    await expect(prepareTomcatUpdate(damaged, fixture.request)).rejects.toThrow("baseline version/hash");
  });

  test("resolves an annotated Apache release tag to its immutable commit", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const pin = fixture.snapshot.pins.majors["9"];
    const tagSha = "a".repeat(40);
    fixture.replies.set(`https://api.github.com/repos/apache/tomcat/git/ref/tags/${pin.version}`, {
      body: JSON.stringify({ object: { type: "tag", sha: tagSha } }),
    });
    fixture.replies.set(`https://api.github.com/repos/apache/tomcat/git/tags/${tagSha}`, {
      body: JSON.stringify({ tag: pin.version, object: { type: "commit", sha: pin.upstreamCommit } }),
    });
    // When
    const result = await prepareTomcatUpdate(fixture.snapshot, fixture.request);
    // Then
    expect(result).toEqual(fixture.snapshot);
  });

  test("reports baseline changes separately from the intentional port customization", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const xml = fixture.snapshot.configs["9"].replace(
      'connectionTimeout="20000"',
      'connectionTimeout="30000"',
    );
    const candidate = {
      pins: {
        ...fixture.snapshot.pins,
        majors: {
          ...fixture.snapshot.pins.majors,
          "9": { ...fixture.snapshot.pins.majors["9"], configSha256: sha256(xml) },
        },
      },
      configs: { ...fixture.snapshot.configs, "9": xml },
    };
    // When
    const report = reportTomcatUpdate(fixture.snapshot, candidate);
    // Then
    expect(report).toContain('connectionTimeout="20000"');
    expect(report).toContain('connectionTimeout="30000"');
    expect(report.indexOf("## Upstream changes")).toBeLessThan(report.indexOf("## Lando customization"));
    expect(report).toContain("active configuration or formatting changed");
  });

  test("does not classify whitespace inside attribute values as equivalent", async () => {
    // Given
    const fixture = await tomcatRegistryFixture();
    const candidate = {
      ...fixture.snapshot,
      configs: {
        ...fixture.snapshot.configs,
        "11": fixture.snapshot.configs["11"].replace("%h %l", "%h  %l"),
      },
    };
    // When
    const report = reportTomcatUpdate(fixture.snapshot, candidate);
    // Then
    expect(report).toContain("active configuration or formatting changed; review required");
  });
});
