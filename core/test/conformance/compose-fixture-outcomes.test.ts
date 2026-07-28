import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";

import type { ComposeDispositionMatch } from "../../src/landofile/compose/rejections.ts";
import { analyzeComposeDispositions } from "../../src/landofile/compose/rejections.ts";
import { deterministicMetadata } from "../../src/services/draft.ts";
import { ComposeFixtureOutcomeError } from "./compose-fixture-outcome-values.ts";
import { assertFixtureServiceOutcomes } from "./compose-fixture-outcomes.ts";

const serviceName = ServiceName.make("web");
const provider = ProviderId.make("test");

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
