import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CRUN_OOM_SCORE_ADJ_BROKEN_AT,
  CRUN_OOM_SCORE_ADJ_FIXED_VERSION,
  versionAtLeast,
} from "@lando/container-runtime/podman/oci-runtime-floor";

describe("managed Linux crun pin", () => {
  test("stays below 1.31 until a fixed crun release is recorded", async () => {
    const sources = (await Bun.file(join(import.meta.dir, "..", "runtime-bundle-sources.json")).json()) as {
      readonly _comment: string;
      readonly bundles: Readonly<
        Record<
          string,
          { readonly components: ReadonlyArray<{ readonly name: string; readonly version: string }> }
        >
      >;
    };

    expect(sources._comment).toContain("1.31");
    expect(sources._comment).toContain("https://github.com/containers/crun/issues/2466");

    for (const host of ["linux-x64", "linux-arm64"] as const) {
      const crun = sources.bundles[host]?.components.find((component) => component.name === "crun");
      expect(crun?.version).toBeDefined();
      if (crun === undefined) continue;
      const allowedByFix =
        CRUN_OOM_SCORE_ADJ_FIXED_VERSION !== undefined &&
        versionAtLeast(crun.version, CRUN_OOM_SCORE_ADJ_FIXED_VERSION);
      expect(allowedByFix || !versionAtLeast(crun.version, CRUN_OOM_SCORE_ADJ_BROKEN_AT)).toBe(true);
    }
  });
});
