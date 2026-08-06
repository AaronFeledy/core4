import { expect, test } from "bun:test";

import {
  type ComposeDisposition,
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "@lando/landofile/compose/dispositions";
import {
  ComposeKeyMatrixError,
  assertMatrixInvariants,
  renderComposeKeyMatrixPage,
} from "../../../scripts/build-compose-key-matrix.ts";

type DispositionMap = Readonly<Record<string, ComposeDispositionEntry>>;

const countDisposition = (entries: DispositionMap, disposition: ComposeDisposition): number =>
  Object.values(entries).filter((entry) => entry.disposition === disposition).length;

const summaryRow = (label: string, entries: DispositionMap): string =>
  `| ${label} | ${countDisposition(entries, "normalized")} | ${countDisposition(entries, "preserved")} | ${countDisposition(entries, "rejected")} | ${Object.keys(entries).length} |`;

test("renders exactly one row for every committed disposition entry", () => {
  // Given
  const servicePaths = Object.keys(composeServiceDispositions);
  const roots = [...new Set(servicePaths.map((path) => path.split(".", 1).join("")))];

  // When
  const page = renderComposeKeyMatrixPage();
  const topLevelSection = page.slice(page.indexOf("## Top-level keys"), page.indexOf("## YAML tags"));
  const tagSection = page.slice(page.indexOf("## YAML tags"), page.indexOf("## Service keys"));
  const serviceSection = page.slice(page.indexOf("## Service keys"));
  const renderedScopes = [
    [composeTopLevelDispositions, topLevelSection],
    [composeServiceDispositions, serviceSection],
    [composeTagDispositions, tagSection],
  ] as const satisfies ReadonlyArray<readonly [DispositionMap, string]>;

  // Then
  for (const [entries, renderedScope] of renderedScopes) {
    const lines = renderedScope.split("\n");
    for (const path of Object.keys(entries)) {
      expect(lines.filter((line) => line.startsWith(`| \`${path}\` |`))).toHaveLength(1);
    }
  }

  expect(page).toContain(summaryRow("Top-level keys", composeTopLevelDispositions));
  expect(page).toContain(summaryRow("Service keys", composeServiceDispositions));
  expect(page).toContain(summaryRow("YAML tags", composeTagDispositions));
  expect(page).toContain("title: Compose Key Matrix");
  expect(page).toContain(
    "description: Generated disposition matrix for every upstream Compose key path Lando classifies.",
  );
  expect(page).toContain(
    "{/* GENERATED FILE — do not hand-edit. Regenerate via `bun run codegen:compose-key-matrix`. */}",
  );

  for (const root of roots) {
    const hasDescendants = servicePaths.some((path) => path.startsWith(`${root}.`));
    const section = `### \`${root}\``;
    if (hasDescendants) {
      expect(page).toContain(section);
    } else {
      expect(page).not.toContain(section);
    }
  }
});

test("describes preserved data without blanket capability gating", () => {
  // Given / When
  const page = renderComposeKeyMatrixPage();

  // Then
  expect(page).toContain(
    "A `preserved` key is accepted and carried in the Compose plan extension; row details determine capability behavior.",
  );
  expect(page).not.toContain("carried in the Compose plan extension for capability checks");
});

test("rejects a disposition entry that violates the matrix invariants", () => {
  // Given
  const invalidServiceEntries = {
    broken: {
      disposition: "rejected",
      rationale: "Fixture rationale.",
    },
  } satisfies DispositionMap;

  // When / Then
  expect(() => assertMatrixInvariants({ service: invalidServiceEntries, topLevel: {}, tags: {} })).toThrow(
    ComposeKeyMatrixError,
  );
});

test("rejects a normalized descendant without a plan target", () => {
  // Given
  const invalidServiceEntries = {
    build: {
      disposition: "normalized",
      rationale: "Fixture rationale.",
      planTarget: ["artifact"],
    },
    "build.args": {
      disposition: "normalized",
      rationale: "Fixture rationale.",
    },
  } satisfies DispositionMap;

  // When / Then
  expect(() => assertMatrixInvariants({ service: invalidServiceEntries, topLevel: {}, tags: {} })).toThrow(
    ComposeKeyMatrixError,
  );
});
