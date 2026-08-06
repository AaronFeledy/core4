import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ComposeKeyRejectedError, LandofileParseError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";

import {
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "../src/compose/dispositions.ts";
import { compileDispositionTrie, matchDispositionPath } from "../src/compose/rejection-trie.ts";
import {
  analyzeComposeRejections,
  composeKeyRejectedError,
  composeTagRejection,
  firstComposeRejection,
  rejectComposeKeys,
  rejectComposeTags,
} from "../src/compose/rejections.ts";

const preserved = { disposition: "preserved", rationale: "Preserved for testing." } as const;
const rejected = {
  disposition: "rejected",
  rationale: "Rejected for testing.",
  remediation: "Remove the test key.",
} as const;

describe("Compose rejection analysis", () => {
  test("prefers exact segments, then x-* segments, then arbitrary map-key segments", () => {
    // Given
    const trie = compileDispositionTrie({
      "labels.*": preserved,
      "labels.special": rejected,
      "build.*": preserved,
      "build.x-*": rejected,
    });

    // When
    const exact = matchDispositionPath(trie, ["labels", "special"]);
    const extension = matchDispositionPath(trie, ["build", "x-vendor"]);
    const wildcard = matchDispositionPath(trie, ["build", "context"]);

    // Then
    expect(exact?.matrixPath).toBe("labels.special");
    expect(extension?.matrixPath).toBe("build.x-*");
    expect(wildcard?.matrixPath).toBe("build.*");
  });

  test("keeps matrix alignment while walking array elements", () => {
    // Given
    const parsed = { services: { web: { ports: [{ target: 80, mode: "host" }] } } };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      matrixPath: "ports.mode",
      documentPath: "services.web.ports[0].mode",
      service: "web",
    });
  });

  test("descends through preserved deploy resources but rejects deploy replicas", () => {
    // Given
    const resources = { services: { web: { deploy: { resources: { limits: { cpus: "0.5" } } } } } };
    const replicas = { services: { web: { deploy: { replicas: 3 } } } };

    // When
    const resourceMatches = analyzeComposeRejections(resources);
    const replicaMatches = analyzeComposeRejections(replicas);

    // Then
    expect(resourceMatches).toEqual([]);
    expect(replicaMatches).toHaveLength(1);
    expect(replicaMatches[0]?.matrixPath).toBe("deploy.replicas");
  });

  test("stops a rejected parent subtree after one match", () => {
    // Given
    const parsed = { services: { web: { extends: { service: "base", file: "x.yml" } } } };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matrixPath).toBe("extends");
  });

  test("finds only deploy.replicas in a mixed resources and replicas fixture", () => {
    // Given
    const parsed = {
      services: { web: { deploy: { resources: { limits: { cpus: "0.5" } }, replicas: 3 } } },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches.map(({ matrixPath }) => matrixPath)).toEqual(["deploy.replicas"]);
  });

  test("decodes resources identically in default and strict modes and remains idempotent", () => {
    // Given
    const parsed = { services: { web: { deploy: { resources: { limits: { cpus: "0.5" } } } } } };

    // When
    const defaultDecoded = Schema.decodeUnknownSync(LandofileShape)(parsed, {});
    const strictDecoded = Schema.decodeUnknownSync(LandofileShape)(parsed, { onExcessProperty: "error" });
    const decodedAgain = Schema.decodeUnknownSync(LandofileShape)(defaultDecoded, {});

    // Then
    expect(defaultDecoded).toEqual(strictDecoded);
    expect(decodedAgain).toEqual(defaultDecoded);
    expect(defaultDecoded).toEqual(parsed);
  });

  test("takes every match remediation from its owning matrix entry", () => {
    // Given
    const parsed = {
      models: { local: {} },
      services: { web: { container_name: "web", deploy: { replicas: 2 } } },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    for (const match of matches) {
      const matrix = match.service === undefined ? composeTopLevelDispositions : composeServiceDispositions;
      expect(matrix[match.matrixPath]?.remediation).toBe(match.remediation);
    }
  });

  test("leaves ordinary Lando service keys and unmatched extension subtrees untouched", () => {
    // Given
    const parsed = {
      services: {
        web: {
          type: "php",
          webroot: "public",
          app_mount: false,
          overrides: { container_name: "nested-is-not-compose" },
          "x-lando-foo": { arbitrary: true },
        },
      },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches).toEqual([]);
  });

  test("attributes service matches and omits service from top-level matches", () => {
    // Given
    const parsed = { models: { local: {} }, services: { api: { container_name: "api" } } };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches[0]).not.toHaveProperty("service");
    expect(matches[1]?.service).toBe("api");
  });

  test("returns the document-order-first service rejection deterministically", () => {
    // Given
    const parsed = {
      services: { zeta: { links: ["db"] }, alpha: { container_name: "alpha" } },
    };

    // When
    const firstMatches = Array.from({ length: 100 }, () => firstComposeRejection(parsed));

    // Then
    expect(firstMatches.every((match) => match?.service === "zeta" && match.matrixPath === "links")).toBe(
      true,
    );
  });

  test("constructs the tagged error from matrix and document paths", () => {
    // Given
    const source = "/workspace/.lando.yml";
    const match = analyzeComposeRejections({ services: { web: { container_name: "web" } } })[0];
    expect(match).toBeDefined();
    if (match === undefined) return;

    // When
    const error = composeKeyRejectedError({ source, match });

    // Then
    expect(error.keyPath).toBe(match.matrixPath);
    expect(error.remediation).toBe(match.remediation);
    expect(error.message).toContain(match.documentPath);
    expect(error.message).toContain(source);
    expect(error.message).toContain(match.rationale);
  });

  test("maps Compose tags to their separate matrix", () => {
    // Given
    const occurrence = { tag: "!reset", line: 4, column: 12 } as const;

    // When
    const match = composeTagRejection(occurrence);

    // Then
    expect(match.matrixPath).toBe("!reset");
    expect(match.documentPath).toBe("!reset");
    expect(match).not.toHaveProperty("service");
    expect(composeTagDispositions["!reset"].remediation).toBe(match.remediation);
  });

  test("covers every section 7.4 rejected service key with exact matrix remediation", () => {
    // Given
    const parsed = {
      services: {
        web: {
          extends: { service: "base" },
          container_name: "web",
          network_mode: "host",
          links: ["db"],
          deploy: {
            replicas: 2,
            placement: { constraints: ["node.role == worker"] },
            update_config: { parallelism: 1 },
            rollback_config: { parallelism: 1 },
            endpoint_mode: "vip",
            mode: "replicated",
            labels: { owner: "platform" },
          },
        },
      },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    expect(matches.map(({ matrixPath }) => matrixPath)).toEqual([
      "extends",
      "container_name",
      "network_mode",
      "links",
      "deploy.replicas",
      "deploy.placement",
      "deploy.update_config",
      "deploy.rollback_config",
      "deploy.endpoint_mode",
      "deploy.mode",
      "deploy.labels",
    ]);
    for (const match of matches) {
      expect(composeServiceDispositions[match.matrixPath]?.remediation).toBe(match.remediation);
    }
  });

  test("rejectComposeKeys passes clean values through and fails with the tagged error", () => {
    // Given
    const clean = { services: { web: { type: "php" } } };
    const rejectedValue = { services: { web: { container_name: "web" } } };

    // When
    const result = Effect.runSync(rejectComposeKeys("/clean.yml", clean));
    const error = Effect.runSync(Effect.flip(rejectComposeKeys("/rejected.yml", rejectedValue)));

    // Then
    expect(result).toBe(clean);
    expect(error).toBeInstanceOf(ComposeKeyRejectedError);
    expect(error.keyPath).toBe("container_name");
  });

  test("rejectComposeTags passes clean content through and rejects the first tag", () => {
    // Given
    const clean = "services:\n  web:\n    type: php\n";
    const tagged = "services:\n  web:\n    ports: !reset []\n";

    // When
    const result = Effect.runSync(rejectComposeTags("/clean.yml", clean));
    const error = Effect.runSync(Effect.flip(rejectComposeTags("/tagged.yml", tagged)));

    // Then
    expect(result).toBe(clean);
    expect(error).toBeInstanceOf(ComposeKeyRejectedError);
    if (!(error instanceof ComposeKeyRejectedError)) return;
    expect(error.keyPath).toBe("!reset");
  });

  test("rejectComposeTags preserves parser failures in its error channel", () => {
    // Given
    const content = "services:\t!reset";

    // When
    const error = Effect.runSync(Effect.flip(rejectComposeTags("/tabs.yml", content)));

    // Then
    expect(error).toBeInstanceOf(LandofileParseError);
    if (!(error instanceof LandofileParseError)) return;
    expect(error._tag).toBe("LandofileParseError");
    expect(error.filePath).toBe("/tabs.yml");
  });
});
