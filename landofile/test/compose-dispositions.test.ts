import { describe, expect, test } from "bun:test";

import { composeServiceDispositions, composeTopLevelDispositions } from "@lando/sdk/landofile";
import { analyzeComposeDispositions, analyzeComposeRejections } from "../src/compose/rejections.ts";

describe("Compose disposition analysis", () => {
  test("reports every disposition in document order and descends through normalized parents", () => {
    // Given
    const parsed = {
      "x-fixture": { ignored: true },
      services: {
        entry: {
          ports: [{ target: 80, mode: "host" }],
        },
      },
    };

    // When
    const matches = analyzeComposeDispositions(parsed);

    // Then
    expect(
      matches.map(({ matrixPath, documentPath, service, disposition }) => [
        matrixPath,
        documentPath,
        service,
        disposition,
      ]),
    ).toEqual([
      ["x-*", "x-fixture", undefined, "preserved"],
      ["services", "services", undefined, "normalized"],
      ["ports", "services.entry.ports", "entry", "normalized"],
      ["ports.target", "services.entry.ports[0].target", "entry", "normalized"],
      ["ports.mode", "services.entry.ports[0].mode", "entry", "rejected"],
    ]);
    for (const match of matches) {
      const matrix = match.service === undefined ? composeTopLevelDispositions : composeServiceDispositions;
      expect(matrix[match.matrixPath]?.rationale).toBe(match.rationale);
    }
    expect(matches[0]).not.toHaveProperty("service");
    expect(matches[0]).not.toHaveProperty("remediation");
    expect(matches[4]?.remediation).toBe(composeServiceDispositions["ports.mode"]?.remediation);
  });

  test("projects rejection matches without changing their public shape", () => {
    // Given
    const parsed = {
      services: {
        entry: {
          ports: [{ target: 80, mode: "host" }],
        },
      },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    const matrixEntry = composeServiceDispositions["ports.mode"];
    if (matrixEntry?.remediation === undefined) {
      throw new Error("ports.mode must stay a rejected key carrying remediation");
    }
    expect(matches).toEqual([
      {
        matrixPath: "ports.mode",
        documentPath: "services.entry.ports[0].mode",
        service: "entry",
        rationale: matrixEntry.rationale,
        remediation: matrixEntry.remediation,
      },
    ]);
    expect(matches[0]).not.toHaveProperty("disposition");
  });

  test("does not descend into Lando build discriminators", () => {
    // Given
    const parsed = {
      services: {
        entry: {
          build: { artifact: "dist", no_cache: true },
        },
      },
    };

    // When
    const matches = analyzeComposeDispositions(parsed);

    // Then
    expect(matches.map(({ matrixPath }) => matrixPath)).toEqual(["services", "build"]);
  });
});
