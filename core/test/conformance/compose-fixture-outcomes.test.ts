import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";

import { deterministicMetadata } from "@lando/engine/services/draft";
import type { ComposeDispositionMatch } from "@lando/landofile/compose/rejections";
import { analyzeComposeDispositions } from "@lando/landofile/compose/rejections";
import { ComposeFixtureOutcomeError } from "./compose-fixture-outcome-values.ts";
import { assertFixtureServiceOutcomes, materializeFixtureEnvFiles } from "./compose-fixture-outcomes.ts";

const serviceName = ServiceName.make("web");
const provider = ProviderId.make("test");

const landofileWithEnvFile = (envFile: string) =>
  Schema.decodeUnknownSync(LandofileShape)({
    name: "env-file-security",
    services: { web: { type: "compose", image: "alpine:3", env_file: [envFile] } },
  });

const missingOutcomeContext = (serviceConfig: Readonly<Record<string, unknown>> = {}) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "vacuity",
    services: { web: { type: "compose", image: "alpine:3", ...serviceConfig } },
  });
  const plan: AppPlan = {
    id: AppId.make("vacuity"),
    name: "vacuity",
    slug: "vacuity",
    root: AbsolutePath.make("/tmp/vacuity"),
    provider,
    services: {
      [serviceName]: {
        name: serviceName,
        type: "compose",
        provider,
        primary: true,
        artifact: { kind: "ref", ref: "alpine:3" },
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: deterministicMetadata,
        extensions: { compose: {} },
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: deterministicMetadata,
    extensions: {},
  };
  return { appRoot: "/tmp/vacuity", landofile, plan };
};

const realMatch = (
  service: Readonly<Record<string, unknown>>,
  matrixPath: string,
): ComposeDispositionMatch => {
  const match = analyzeComposeDispositions({ services: { web: service } }).find(
    (candidate) => candidate.service === "web" && candidate.matrixPath === matrixPath,
  );
  if (match === undefined) throw new ComposeFixtureOutcomeError(`Missing test match ${matrixPath}`);
  return match;
};

describe("Compose fixture outcome assertions", () => {
  test("throws when a normalized direct match has no decoded source or plan output", () => {
    // Given
    const match = realMatch({ command: ["echo", "ready"] }, "command");

    // When / Then
    expect(() => assertFixtureServiceOutcomes([match], missingOutcomeContext())).toThrow(
      ComposeFixtureOutcomeError,
    );
  });

  test("throws when a preserved decoded source has no extension output", () => {
    // Given
    const match = realMatch({ labels: { "com.example.role": "worker" } }, "labels");

    // When / Then
    expect(() =>
      assertFixtureServiceOutcomes(
        [match],
        missingOutcomeContext({ labels: { "com.example.role": "worker" } }),
      ),
    ).toThrow(ComposeFixtureOutcomeError);
  });

  test("throws when a matched canonical volume has no plan projection", () => {
    // Given
    const match = realMatch({ volumes: ["./src:/workspace"] }, "volumes");

    // When / Then
    expect(() =>
      assertFixtureServiceOutcomes([match], missingOutcomeContext({ volumes: ["./src:/workspace"] })),
    ).toThrow(ComposeFixtureOutcomeError);
  });
});

describe("Compose fixture env file materialization", () => {
  test("rejects relative traversal without changing an outside file", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-env-"));
    const appRoot = join(root, "app");
    const sentinel = join(root, "outside.env");
    await mkdir(appRoot);
    await writeFile(sentinel, "sentinel\n");

    try {
      // When / Then
      await expect(
        materializeFixtureEnvFiles(appRoot, landofileWithEnvFile("../outside.env")),
      ).rejects.toBeInstanceOf(ComposeFixtureOutcomeError);
      expect(await readFile(sentinel, "utf8")).toBe("sentinel\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects an absolute path without changing an outside file", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-env-"));
    const appRoot = join(root, "app");
    const sentinel = join(root, "outside.env");
    await mkdir(appRoot);
    await writeFile(sentinel, "sentinel\n");

    try {
      // When / Then
      await expect(
        materializeFixtureEnvFiles(appRoot, landofileWithEnvFile(sentinel)),
      ).rejects.toBeInstanceOf(ComposeFixtureOutcomeError);
      expect(await readFile(sentinel, "utf8")).toBe("sentinel\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked parent without changing an outside file", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-env-"));
    const appRoot = join(root, "app");
    const outsideRoot = join(root, "outside");
    const sentinel = join(outsideRoot, "sentinel.env");
    await mkdir(appRoot);
    await mkdir(outsideRoot);
    await writeFile(sentinel, "sentinel\n");
    await symlink(outsideRoot, join(appRoot, "linked"), "dir");

    try {
      // When / Then
      await expect(
        materializeFixtureEnvFiles(appRoot, landofileWithEnvFile("linked/nested/sentinel.env")),
      ).rejects.toBeInstanceOf(ComposeFixtureOutcomeError);
      expect(await readFile(sentinel, "utf8")).toBe("sentinel\n");
      expect(await readdir(outsideRoot)).toEqual(["sentinel.env"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not follow an existing destination symlink", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-compose-env-"));
    const appRoot = join(root, "app");
    const sentinel = join(root, "outside.env");
    await mkdir(appRoot);
    await writeFile(sentinel, "sentinel\n");
    await symlink(sentinel, join(appRoot, "fixture.env"));

    try {
      // When / Then
      await expect(
        materializeFixtureEnvFiles(appRoot, landofileWithEnvFile("fixture.env")),
      ).rejects.toBeInstanceOf(ComposeFixtureOutcomeError);
      expect(await readFile(sentinel, "utf8")).toBe("sentinel\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
