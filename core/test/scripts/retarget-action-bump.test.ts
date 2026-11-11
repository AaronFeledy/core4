import { describe, expect, test } from "bun:test";
import { type PinSource, applyPinMoves, parsePinDiff } from "../../../scripts/retarget-action-pins.ts";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const workflowDiff = (path: string, removed: string, added: string): string => `diff --git a/${path} b/${path}
index 111..222 100644
--- a/${path}
+++ b/${path}
@@ -1,3 +1,3 @@
       - name: Upload
${removed}
${added}
         with:
`;

describe("parsePinDiff", () => {
  test("collapses repeated tag bumps and keeps a distinct sha bump", () => {
    const diff = [
      workflowDiff(
        ".github/workflows/ci.yml",
        "-        uses: example/build-action@v3",
        "+        uses: example/build-action@v4",
      ),
      workflowDiff(
        ".github/workflows/nightly.yml",
        `-        uses: example/build-action@${OLD_SHA} # v1.2.3`,
        `+        uses: example/build-action@${NEW_SHA} # v1.2.4`,
      ),
      workflowDiff(
        ".github/workflows/rails-journey.yml",
        "-        uses: example/build-action@v3",
        "+        uses: example/build-action@v4",
      ),
      workflowDiff(
        ".github/workflows/release.yml",
        "-      - uses: example/checkout-action@cccc # v9.0.0",
        "+      - uses: example/checkout-action@dddd # v9.0.1",
      ),
    ].join("");

    const parsed = parsePinDiff(diff);

    expect(parsed).toEqual({
      kind: "ok",
      moves: [
        {
          action: "example/build-action",
          oldRef: "v3",
          newRef: "v4",
          oldComment: undefined,
          newComment: undefined,
        },
        {
          action: "example/build-action",
          oldRef: OLD_SHA,
          newRef: NEW_SHA,
          oldComment: "v1.2.3",
          newComment: "v1.2.4",
        },
        {
          action: "example/checkout-action",
          oldRef: "cccc",
          newRef: "dddd",
          oldComment: "v9.0.0",
          newComment: "v9.0.1",
        },
      ],
      workflowPaths: [
        ".github/workflows/ci.yml",
        ".github/workflows/nightly.yml",
        ".github/workflows/rails-journey.yml",
        ".github/workflows/release.yml",
      ],
    });
  });

  test("rejects edits that are not an in-place workflow pin replacement", () => {
    const nonPin = workflowDiff(
      ".github/workflows/ci.yml",
      "-        run: bun test",
      "+        run: bun test --coverage",
    );
    const outside = workflowDiff("README.md", "-old", "+new");
    const conflict = [
      workflowDiff(
        ".github/workflows/ci.yml",
        "-        uses: example/build-action@v3",
        "+        uses: example/build-action@v4",
      ),
      workflowDiff(
        ".github/workflows/nightly.yml",
        "-        uses: example/build-action@v3",
        "+        uses: example/build-action@v5",
      ),
    ].join("");

    expect(parsePinDiff(nonPin)).toMatchObject({ kind: "rejected" });
    expect(parsePinDiff(outside)).toMatchObject({ kind: "rejected" });
    expect(parsePinDiff(conflict)).toEqual({
      kind: "rejected",
      reason: "conflicting updates for example/build-action@v3",
    });
  });
});

describe("applyPinMoves", () => {
  const sources = (): PinSource[] => [
    {
      path: "scripts/pins.ts",
      text: `export const PINS = {\n  upload: "example/build-action@${OLD_SHA}",\n} as const;\n`,
    },
    {
      path: "scripts/build-example.ts",
      text: [
        "uses: ${PINS.upload} # v1.2.3",
        "uses: example/build-action@v3",
        "uses: example/build-action@v3.0.0",
        "",
      ].join("\n"),
    },
  ];

  test("updates literals, pin constants, and interpolation comments without eating a longer ref", () => {
    const applied = applyPinMoves(sources(), [
      {
        action: "example/build-action",
        oldRef: "v3",
        newRef: "v4",
        oldComment: undefined,
        newComment: undefined,
      },
      {
        action: "example/build-action",
        oldRef: OLD_SHA,
        newRef: NEW_SHA,
        oldComment: "v1.2.3",
        newComment: "v1.2.4",
      },
    ]);

    expect(applied).toEqual({
      kind: "applied",
      files: [
        {
          path: "scripts/pins.ts",
          text: `export const PINS = {\n  upload: "example/build-action@${NEW_SHA}",\n} as const;\n`,
        },
        {
          path: "scripts/build-example.ts",
          text: [
            "uses: ${PINS.upload} # v1.2.4",
            "uses: example/build-action@v4",
            "uses: example/build-action@v3.0.0",
            "",
          ].join("\n"),
        },
      ],
    });
  });

  test("reports a pin the sources do not contain and leaves an already-current tree unchanged", () => {
    const missing = applyPinMoves(sources(), [
      {
        action: "example/missing-action",
        oldRef: "v1",
        newRef: "v2",
        oldComment: undefined,
        newComment: undefined,
      },
    ]);
    const current = applyPinMoves(
      [
        {
          path: "scripts/build-example.ts",
          text: `uses: example/build-action@${NEW_SHA} # v1.2.4\n`,
        },
      ],
      [
        {
          action: "example/build-action",
          oldRef: OLD_SHA,
          newRef: NEW_SHA,
          oldComment: "v1.2.3",
          newComment: "v1.2.4",
        },
      ],
    );

    expect(missing).toEqual({ kind: "unresolved", action: "example/missing-action", oldRef: "v1" });
    expect(current).toEqual({ kind: "applied", files: [] });
  });
});
