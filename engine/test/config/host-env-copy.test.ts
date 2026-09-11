import { describe, expect, test } from "bun:test";

import { copyPresentHostEnv } from "../../src/config/host-env-copy.ts";

describe("copyPresentHostEnv", () => {
  test("copies only allowlisted names that are set", () => {
    expect(
      copyPresentHostEnv({ KEEP: "yes", ALSO: "", SKIP: "no", MISSING: undefined }, [
        "KEEP",
        "ALSO",
        "MISSING",
        "ABSENT",
      ]),
    ).toEqual({ KEEP: "yes", ALSO: "" });
  });

  test("never copies a name outside the caller allowlist", () => {
    expect(copyPresentHostEnv({ HOST_SECRET: "x", TERM_PROGRAM: "ghostty" }, ["TERM"])).toEqual({});
  });
});
