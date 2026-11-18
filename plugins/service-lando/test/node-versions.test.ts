import { describe, expect, test } from "bun:test";
import {
  NODE_LTS_MAJOR,
  SUPPORTED_NODE_MAJORS,
  SUPPORTED_NODE_VERSIONS,
  selectLatestLtsMajor,
} from "../src/services/node-versions.ts";

describe("node release derivation", () => {
  test("selects the highest supported major with an LTS date", () => {
    expect(
      selectLatestLtsMajor([
        { major: 22, lts: "2024-10-29" },
        { major: 24, lts: "2025-10-28" },
        { major: 26, lts: "2026-10-28" },
      ]),
    ).toBe(26);
    expect(
      selectLatestLtsMajor([
        { major: 22, lts: "2024-10-29" },
        { major: 24, lts: null },
        { major: 26, lts: "2026-10-28" },
      ]),
    ).toBe(26);
    expect(
      selectLatestLtsMajor([
        { major: 24, lts: "2025-10-28" },
        { major: 26, lts: null },
      ]),
    ).toBe(24);
    expect(selectLatestLtsMajor([{ major: 26, lts: null }])).toBeUndefined();
  });

  test("derives the LTS alias and version list from the committed manifest", () => {
    expect<number | undefined>(NODE_LTS_MAJOR).toBe(selectLatestLtsMajor(SUPPORTED_NODE_MAJORS));
    expect<readonly string[]>([...SUPPORTED_NODE_VERSIONS]).toEqual([
      "lts",
      ...SUPPORTED_NODE_MAJORS.map((entry) => String(entry.major)),
    ]);
  });
});
