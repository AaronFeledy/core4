import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

type ChecksumResult = {
  readonly entries: ReadonlyArray<{ readonly vendored: string; readonly ok: boolean }>;
  readonly missing: ReadonlyArray<string>;
  readonly unpinned: ReadonlyArray<string>;
  readonly ok: boolean;
};

type ComposeFixtureModule = {
  readonly ComposeFixturePinError: ErrorConstructor;
  readonly composeFixtureSourceUrl: (ref: string, path: string) => string;
  readonly listComposeFixtures: (options: {
    readonly fixturesRoot: string;
  }) => Promise<ReadonlyArray<string>>;
  readonly parseComposeFixturePin: (value: unknown, pinPath: string) => unknown;
  readonly verifyComposeFixtureChecksums: (paths: {
    readonly pinPath: string;
    readonly fixturesRoot: string;
  }) => Promise<ChecksumResult>;
};

class ComposeFixtureModuleLoadError extends Error {
  constructor() {
    super("Invalid compose fixture module exports");
    this.name = "ComposeFixtureModuleLoadError";
  }
}

const isComposeFixtureModule = (value: unknown): value is ComposeFixtureModule =>
  typeof value === "object" &&
  value !== null &&
  "ComposeFixturePinError" in value &&
  typeof value.ComposeFixturePinError === "function" &&
  "composeFixtureSourceUrl" in value &&
  typeof value.composeFixtureSourceUrl === "function" &&
  "listComposeFixtures" in value &&
  typeof value.listComposeFixtures === "function" &&
  "parseComposeFixturePin" in value &&
  typeof value.parseComposeFixturePin === "function" &&
  "verifyComposeFixtureChecksums" in value &&
  typeof value.verifyComposeFixtureChecksums === "function";

const repoRoot = resolve(import.meta.dirname, "../../..");
const importedModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/compose-fixtures.ts")).href
);
if (!isComposeFixtureModule(importedModule)) throw new ComposeFixtureModuleLoadError();
const {
  ComposeFixturePinError,
  composeFixtureSourceUrl,
  listComposeFixtures,
  parseComposeFixturePin,
  verifyComposeFixtureChecksums,
} = importedModule;
const fixturesRoot = resolve(repoRoot, "core/test/fixtures/compose");
const pinPath = resolve(fixturesRoot, "pin.json");
const ref = "7cc9c7ce7fa630fc8e250482e1feae397459352b";
const sourceUrlPrefix = `https://raw.githubusercontent.com/compose-spec/conformance-tests/${ref}/`;

const validPin = () => ({
  repo: "https://github.com/compose-spec/conformance-tests",
  ref,
  sourceUrlPrefix,
  license: "Apache-2.0",
  files: [
    {
      path: "tests/scaling/compose.yaml",
      vendored: "upstream/scaling.compose.yaml",
      sha256: "a".repeat(64),
    },
  ],
});

test("source URLs keep encoded dot segments inside the pinned repository path", () => {
  // Given
  const sourcePath = "%2e%2e/%2E%2E/attacker/repo/payload.compose.yaml";

  // When
  const sourceUrl = composeFixtureSourceUrl(ref, sourcePath);

  // Then
  expect(new URL(sourceUrl).pathname).toBe(
    `/compose-spec/conformance-tests/${ref}/%252e%252e/%252E%252E/attacker/repo/payload.compose.yaml`,
  );
});

describe("compose fixture checksums", () => {
  test("matches every committed upstream fixture without network access", async () => {
    // Given / When
    const result = await verifyComposeFixtureChecksums({ pinPath, fixturesRoot });

    // Then
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unpinned).toEqual([]);
    expect(result.entries.every((entry) => entry.ok)).toBe(true);
  });

  test("detects altered vendored bytes without network access", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-fixtures-tamper-"));
    try {
      await cp(fixturesRoot, root, { recursive: true });
      const altered = "upstream/scaling.compose.yaml";
      await writeFile(join(root, altered), "services: {}\n", "utf8");

      // When
      const result = await verifyComposeFixtureChecksums({
        pinPath: join(root, "pin.json"),
        fixturesRoot: root,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.entries.find((entry) => entry.vendored === altered)?.ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports pinned missing files and unpinned upstream files", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-fixtures-drift-"));
    try {
      await cp(fixturesRoot, root, { recursive: true });
      const missing = "upstream/scaling.compose.yaml";
      const unpinned = "upstream/extra.compose.yaml";
      await rm(join(root, missing));
      await writeFile(join(root, unpinned), "services: {}\n", "utf8");

      // When
      const result = await verifyComposeFixtureChecksums({
        pinPath: join(root, "pin.json"),
        fixturesRoot: root,
      });

      // Then
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual([missing]);
      expect(result.unpinned).toEqual([unpinned]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("compose fixture pin parsing", () => {
  test("rejects a short non-hex commit ref", () => {
    // Given
    const value = { ...validPin(), ref: "not-a-commit" };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects traversal in a vendored path", () => {
    // Given
    const value = {
      ...validPin(),
      files: [{ ...validPin().files[0], vendored: "upstream/../escape.compose.yaml" }],
    };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects a malformed sha256", () => {
    // Given
    const value = { ...validPin(), files: [{ ...validPin().files[0], sha256: "bad" }] };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects duplicate vendored paths", () => {
    // Given
    const entry = validPin().files[0];
    const value = { ...validPin(), files: [entry, { ...entry, path: "LICENSE" }] };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects duplicate upstream source paths", () => {
    // Given
    const entry = validPin().files[0];
    const value = {
      ...validPin(),
      files: [entry, { ...entry, vendored: "upstream/scaling-copy.compose.yaml" }],
    };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects filesystem aliases for source and vendored paths", () => {
    // Given
    const entry = validPin().files[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const sourceAlias = {
      ...validPin(),
      files: [entry, { ...entry, path: `./${entry.path}`, vendored: "upstream/source-alias.compose.yaml" }],
    };
    const vendoredAlias = {
      ...validPin(),
      files: [
        entry,
        {
          ...entry,
          path: "tests/vendored-alias/compose.yaml",
          vendored: `upstream/./${entry.vendored.split("/").at(-1)}`,
        },
      ],
    };

    // When / Then
    expect(() => parseComposeFixturePin(sourceAlias, "pin.json")).toThrow(ComposeFixturePinError);
    expect(() => parseComposeFixturePin(vendoredAlias, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects a source URL prefix for another repository", () => {
    // Given
    const value = {
      ...validPin(),
      sourceUrlPrefix: `https://raw.githubusercontent.com/example/conformance-tests/${ref}/`,
    };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });

  test("rejects a source URL prefix with a suffix after the pinned ref", () => {
    // Given
    const value = { ...validPin(), sourceUrlPrefix: `${sourceUrlPrefix}unexpected/` };

    // When / Then
    expect(() => parseComposeFixturePin(value, "pin.json")).toThrow(ComposeFixturePinError);
  });
});

describe("compose fixture enumeration", () => {
  test("returns every committed fixture in stable sorted order", async () => {
    // Given
    const expected = [
      "corpus/depends-on-conditions.compose.yaml",
      "corpus/environment-files-labels.compose.yaml",
      "corpus/healthcheck.compose.yaml",
      "corpus/long-form-mounts-ports.compose.yaml",
      "corpus/rejected-container-name.compose.yaml",
      "corpus/runtime-knobs.compose.yaml",
      "corpus/service-extensions.compose.yaml",
      "corpus/service-profiles.compose.yaml",
      "corpus/udp-port.compose.yaml",
      "upstream/different_networks.compose.yaml",
      "upstream/scaling.compose.yaml",
      "upstream/simple_configfile.compose.yaml",
      "upstream/simple_lifecycle.compose.yaml",
      "upstream/simple_network.compose.yaml",
      "upstream/simple_secretfile.compose.yaml",
      "upstream/simple_volume.compose.yaml",
      "upstream/udp_port.compose.yaml",
    ];

    // When
    const first = await listComposeFixtures({ fixturesRoot });
    const second = await listComposeFixtures({ fixturesRoot });

    // Then
    expect(first).toEqual(expected);
    expect(second).toEqual(first);
    expect(first).toEqual([...first].sort());
  });

  test("enumerates nested fixture files relative to the fixture root", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-fixture-list-"));
    try {
      await mkdir(join(root, "corpus", "nested"), { recursive: true });
      await mkdir(join(root, "upstream"), { recursive: true });
      await writeFile(join(root, "corpus", "nested", "z.compose.yaml"), "services: {}\n", "utf8");
      await writeFile(join(root, "upstream", "a.compose.yaml"), "services: {}\n", "utf8");

      // When
      const listed = await listComposeFixtures({ fixturesRoot: root });

      // Then
      expect(listed).toEqual(["corpus/nested/z.compose.yaml", "upstream/a.compose.yaml"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
