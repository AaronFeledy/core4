import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { extractArchive } from "../src/archive.ts";
import { SourceAcquisitionError, displaySource } from "../src/errors.ts";
import { checkNpmPackageDistIntegrity } from "../src/integrity.ts";
import { gitCloneUrl, isGitSource, isLiteralGitRef, splitSourceRef } from "../src/locator.ts";
import { isSemverRangeSpecifier, parseNpmPackageSpec, resolveNpmPackageVersion } from "../src/npm.ts";
import { containedPath } from "../src/tree.ts";
import { makeTar, makeTarGz, shasumOf, sriSha256 } from "./support.ts";

test("store containment uses native separators when process.platform is overridden", () => {
  const root = join(tmpdir(), "source-store");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) throw new Error("Missing process.platform descriptor");
  Object.defineProperty(process, "platform", { ...descriptor, value: sep === "\\" ? "linux" : "win32" });
  try {
    expect(() => containedPath(root, "..", "escape")).toThrow(SourceAcquisitionError);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

describe("locator helpers", () => {
  test("splitSourceRef keeps authority @ and splits trailing ref", () => {
    expect(splitSourceRef("git@github.com:org/repo.git")).toEqual({
      value: "git@github.com:org/repo.git",
    });
    expect(splitSourceRef("https://github.com/org/repo.git@main")).toEqual({
      value: "https://github.com/org/repo.git",
      ref: "main",
    });
  });

  test("gitCloneUrl normalizes github: and git+", () => {
    expect(isGitSource("github:org/repo")).toBe(true);
    expect(gitCloneUrl("github:org/repo")).toBe("https://github.com/org/repo.git");
    expect(gitCloneUrl("git+https://example.com/r.git")).toBe("https://example.com/r.git");
  });

  test("isLiteralGitRef rejects unsafe refs", () => {
    expect(isLiteralGitRef("main")).toBe(true);
    expect(isLiteralGitRef("a".repeat(40))).toBe(true);
    expect(isLiteralGitRef("")).toBe(false);
    expect(isLiteralGitRef("feat/../x")).toBe(false);
    expect(isLiteralGitRef("x.lock")).toBe(false);
  });
});

describe("npm integrity and version resolution", () => {
  test("first SRI token wins; missing both is unverifiable", () => {
    const bytes = new TextEncoder().encode("payload");
    const good = sriSha256(bytes);
    expect(checkNpmPackageDistIntegrity(bytes, { tarball: "t", integrity: good }).status).toBe("verified");
    expect(
      checkNpmPackageDistIntegrity(bytes, {
        tarball: "t",
        integrity: `${good} sha512-dead`,
      }).status,
    ).toBe("verified");
    expect(checkNpmPackageDistIntegrity(bytes, { tarball: "t" }).status).toBe("unverifiable");
    expect(checkNpmPackageDistIntegrity(bytes, { tarball: "t", shasum: shasumOf(bytes) }).status).toBe(
      "verified",
    );
  });

  test("parseNpmPackageSpec rejects ranges and bare scopes", () => {
    expect(parseNpmPackageSpec("@lando/php@1.2.3")).toEqual({
      name: "@lando/php",
      version: "1.2.3",
    });
    expect(isSemverRangeSpecifier("^1.0.0")).toBe(true);
    expect(() => parseNpmPackageSpec("@lando/php@^1.0.0")).toThrow(SourceAcquisitionError);
    expect(() => parseNpmPackageSpec("@lando")).toThrow(SourceAcquisitionError);
  });

  test("resolveNpmPackageVersion prefers dist-tags then exact versions", () => {
    const packument = {
      "dist-tags": { latest: "2.0.0", next: "3.0.0-beta" },
      versions: {
        "1.0.0": { dist: { tarball: "t1" } },
        "2.0.0": { dist: { tarball: "t2" } },
        "3.0.0-beta": { dist: { tarball: "t3" } },
      },
    };
    expect(resolveNpmPackageVersion(packument, undefined, "p")).toBe("2.0.0");
    expect(resolveNpmPackageVersion(packument, "next", "p")).toBe("3.0.0-beta");
    expect(resolveNpmPackageVersion(packument, "1.0.0", "p")).toBe("1.0.0");
    expect(() => resolveNpmPackageVersion(packument, "9.9.9", "p")).toThrow(SourceAcquisitionError);
  });

  test("displaySource strips userinfo query fragment from URLs in messages", () => {
    const redacted = displaySource("fetch https://user:pass@reg.example/npm/?token=1#frag failed");
    expect(redacted).toBe("fetch https://reg.example/npm/ failed");
  });
});

describe("extractArchive", () => {
  test("extracts regular files and skips links; rejects traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-extract-"));
    try {
      const bytes = makeTarGz([
        { name: "ok.txt", bytes: new TextEncoder().encode("ok\n") },
        { name: "link", bytes: new TextEncoder().encode("target"), typeflag: 0x32 },
      ]);
      await extractArchive(bytes, dir);
      expect(await readFile(join(dir, "ok.txt"), "utf8")).toBe("ok\n");
      const names = await readdir(dir);
      expect(names).not.toContain("link");

      const evil = makeTar([{ name: "../escape.txt", bytes: new TextEncoder().encode("x") }]);
      await expect(extractArchive(evil, dir)).rejects.toBeInstanceOf(SourceAcquisitionError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
