import { describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";

import { makeBuildTranscriptPath } from "../../src/services/build-transcript.ts";

describe("makeBuildTranscriptPath", () => {
  test("contains branded identifiers within the builds root", () => {
    // Given
    const userDataRoot = resolve("/tmp/lando-data");

    // When
    const paths = [
      makeBuildTranscriptPath({
        userDataRoot,
        appId: "../../outside",
        phase: "artifact",
        serviceName: "../web",
        buildKey: "../../artifact",
        scratch: true,
      }),
      makeBuildTranscriptPath({
        userDataRoot,
        appId: "../../outside",
        phase: "app",
        serviceName: "../web",
        buildKey: "../../app",
        scratch: false,
      }),
    ];

    // Then
    const buildsRoot = resolve(userDataRoot, "builds");
    for (const path of paths) {
      expect(relative(buildsRoot, path).startsWith("..")).toBe(false);
    }
  });
});
