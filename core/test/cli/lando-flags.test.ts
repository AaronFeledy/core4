import { describe, expect, test } from "bun:test";

import {
  LANDO_FLAGS,
  failedLandoFlag,
  hasDiagnosticFlag,
  isSpaceFormJsonFieldList,
  landoFlagFooterLabels,
  matchLandoFlag,
  scanLandoFlags,
} from "../../src/cli/lando-flags.ts";

const matchShape = (token: string, next?: string) => {
  const match = matchLandoFlag(token, next);
  return match === undefined
    ? undefined
    : {
        spelling: match.flag.spelling,
        value: match.value,
        attached: match.attached,
        consumed: match.consumed,
      };
};

describe("LANDO_FLAGS", () => {
  test("every row matches its own bare spelling", () => {
    for (const flag of LANDO_FLAGS) {
      expect(matchLandoFlag(flag.spelling, undefined)?.flag).toBe(flag);
    }
  });

  test("spellings are unique and cover the dispatcher surface", () => {
    const spellings = LANDO_FLAGS.map((flag) => flag.spelling);
    expect(new Set(spellings).size).toBe(spellings.length);
    for (const spelling of [
      "--format",
      "--json",
      "-j",
      "--jq",
      "--renderer",
      "--verbose",
      "--debug",
      "--log-level",
      "--trace",
      "--no-deprecation-warnings",
      "--help",
      "-h",
      "--version",
      "-v",
    ]) {
      expect(spellings).toContain(spelling);
    }
  });

  test("only the result-encoding flags are marked output", () => {
    const output = LANDO_FLAGS.filter((flag) => flag.output === true).map((flag) => flag.spelling);
    expect(output).toEqual(["--format", "--json", "-j", "--jq"]);
  });
});

describe("matchLandoFlag", () => {
  type AcceptedMatch = {
    readonly token: string;
    readonly next?: string;
    readonly spelling: string;
    readonly value?: string;
    readonly attached?: boolean;
    readonly consumed: 0 | 1;
  };
  const accepted: ReadonlyArray<AcceptedMatch> = [
    { token: "--trace", spelling: "--trace", consumed: 0 },
    { token: "--debug", spelling: "--debug", consumed: 0 },
    { token: "--verbose", spelling: "--verbose", consumed: 0 },
    { token: "--no-deprecation-warnings", spelling: "--no-deprecation-warnings", consumed: 0 },
    { token: "-j", spelling: "-j", consumed: 0 },
    { token: "--help", spelling: "--help", consumed: 0 },
    { token: "-h", spelling: "-h", consumed: 0 },
    { token: "--version", spelling: "--version", consumed: 0 },
    { token: "-v", spelling: "-v", consumed: 0 },
    { token: "--expand", spelling: "--expand", consumed: 0 },
    { token: "--no-expand", spelling: "--no-expand", consumed: 0 },
    { token: "--no-expand=true", spelling: "--no-expand", value: "true", attached: true, consumed: 0 },
    { token: "--collapse", spelling: "--collapse", consumed: 0 },
    { token: "--no-collapse", spelling: "--no-collapse", consumed: 0 },
    { token: "--no-tail", spelling: "--no-tail", consumed: 0 },
    { token: "--log-level=debug", spelling: "--log-level", value: "debug", attached: true, consumed: 0 },
    { token: "--log-level", next: "debug", spelling: "--log-level", value: "debug", consumed: 1 },
    { token: "--renderer=plain", spelling: "--renderer", value: "plain", attached: true, consumed: 0 },
    { token: "--renderer", next: "plain", spelling: "--renderer", value: "plain", consumed: 1 },
    { token: "--format=json", spelling: "--format", value: "json", attached: true, consumed: 0 },
    { token: "--format", next: "json", spelling: "--format", value: "json", consumed: 1 },
    { token: "--jq=.app", spelling: "--jq", value: ".app", attached: true, consumed: 0 },
    { token: "--jq", next: ".app", spelling: "--jq", value: ".app", consumed: 1 },
    { token: "--json", spelling: "--json", consumed: 0 },
    { token: "--json=a,b", spelling: "--json", value: "a,b", attached: true, consumed: 0 },
    { token: "--json", next: "a,b", spelling: "--json", value: "a,b", consumed: 1 },
    { token: "--json", next: "app.services", spelling: "--json", value: "app.services", consumed: 1 },
    { token: "--tail", spelling: "--tail", consumed: 0 },
    { token: "--tail", next: "--verbose", spelling: "--tail", consumed: 0 },
  ];

  for (const entry of accepted) {
    test(`matches ${entry.next === undefined ? entry.token : `${entry.token} ${entry.next}`}`, () => {
      expect(matchShape(entry.token, entry.next)).toEqual({
        spelling: entry.spelling,
        value: entry.value,
        attached: entry.attached ?? false,
        consumed: entry.consumed,
      });
    });
  }

  const rejected: ReadonlyArray<{ readonly token: string; readonly next?: string }> = [
    { token: "--verbose=true" },
    { token: "--verbose=false" },
    { token: "--debug=false" },
    { token: "--trace=1" },
    { token: "--help=true" },
    { token: "-j=1" },
    { token: "--tail=5" },
    { token: "--tail", next: "5" },
    { token: "--service" },
    { token: "=" },
    { token: "--=x" },
  ];
  test.each(rejected)("does not match $token", ({ token, next }) => {
    expect(matchLandoFlag(token, next)).toBeUndefined();
  });

  test("--json is bare without a field-list neighbor and consumes a field list", () => {
    expect(matchShape("--json")).toEqual({
      spelling: "--json",
      value: undefined,
      attached: false,
      consumed: 0,
    });
    expect(matchShape("--json", "k1,k2")?.consumed).toBe(1);
    expect(matchShape("--json", "app.services")?.value).toBe("app.services");
    expect(matchShape("--json", "echo")).toEqual({
      spelling: "--json",
      value: undefined,
      attached: false,
      consumed: 0,
    });
  });

  for (const spelling of ["--format", "--renderer", "--log-level", "--jq"] as const) {
    test(`${spelling} distinguishes missing, flag-shaped, attached-empty, and adjacent-empty values`, () => {
      expect(matchShape(spelling)).toEqual({ spelling, value: undefined, attached: false, consumed: 0 });
      expect(matchShape(spelling, "--json")).toEqual({
        spelling,
        value: undefined,
        attached: false,
        consumed: 0,
      });
      expect(matchShape(`${spelling}=`)).toEqual({ spelling, value: "", attached: true, consumed: 0 });
      expect(matchShape(spelling, "")).toEqual({ spelling, value: "", attached: false, consumed: 1 });
    });
  }
});

describe("isSpaceFormJsonFieldList", () => {
  test("accepts field lists and rejects single bare identifiers", () => {
    expect(isSpaceFormJsonFieldList("a,b")).toBe(true);
    expect(isSpaceFormJsonFieldList("app.services")).toBe(true);
    expect(isSpaceFormJsonFieldList("echo")).toBe(false);
    expect(isSpaceFormJsonFieldList("")).toBe(false);
    expect(isSpaceFormJsonFieldList("-a,b")).toBe(false);
  });
});

describe("scanLandoFlags", () => {
  test("stops at -- and preserves every token after it", () => {
    const visited: string[] = [];
    const remaining = scanLandoFlags(["cmd", "--format=json", "--", "--format=json", "--json"], {
      "--format": (match) => {
        visited.push(match.value ?? "");
      },
    });
    expect(visited).toEqual(["json"]);
    expect(remaining).toEqual(["cmd", "--", "--format=json", "--json"]);
  });

  test("preserves the order of unhandled tokens", () => {
    const remaining = scanLandoFlags(["a", "--format=json", "b", "--service", "c"], {
      "--format": () => undefined,
    });
    expect(remaining).toEqual(["a", "b", "--service", "c"]);
  });

  test("keeps a matching flag that has no handler, with its value", () => {
    const remaining = scanLandoFlags(["--json", "app,services", "--renderer", "plain"], {
      "--format": () => undefined,
    });
    expect(remaining).toEqual(["--json", "app,services", "--renderer", "plain"]);
  });

  test("drops a consumed value with the flag and passes the full match", () => {
    const seen: Array<readonly [string, string | undefined, boolean, 0 | 1]> = [];
    const remaining = scanLandoFlags(["--format", "json", "--trace", "tail"], {
      "--format": (match) => {
        seen.push([match.flag.spelling, match.value, match.attached, match.consumed]);
      },
      "--trace": (match) => {
        seen.push([match.flag.spelling, match.value, match.attached, match.consumed]);
      },
    });
    expect(seen).toEqual([
      ["--format", "json", false, 1],
      ["--trace", undefined, false, 0],
    ]);
    expect(remaining).toEqual(["tail"]);
  });

  test("returns an empty walk unchanged", () => {
    expect(scanLandoFlags([], { "--trace": () => undefined })).toEqual([]);
  });

  test("skips sparse holes", () => {
    const argv = new Array<string>(4);
    argv[1] = "keep";
    argv[2] = "--";
    argv[3] = "child";
    expect(scanLandoFlags(argv, {})).toEqual(["keep", "--", "child"]);
  });

  test("records the failing match against the thrown error and rethrows it", () => {
    const failure = new Error("renderer-selection failed");
    try {
      scanLandoFlags(["--renderer=", "--trace"], {
        "--renderer": () => {
          throw failure;
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBe(failure);
      expect(failedLandoFlag(error)?.flag.spelling).toBe("--renderer");
      expect(failedLandoFlag(error)?.value).toBe("");
      expect(failedLandoFlag(error)?.attached).toBe(true);
    }
  });

  test("reports no match for values that did not come from a handler", () => {
    expect(failedLandoFlag(new Error("unrelated"))).toBeUndefined();
    expect(failedLandoFlag("not an error")).toBeUndefined();
    expect(failedLandoFlag(undefined)).toBeUndefined();
  });
});

describe("hasDiagnosticFlag", () => {
  test("is true for the flags marked diagnostic in the table", () => {
    const diagnostic = LANDO_FLAGS.filter((flag) => flag.diagnostic === true).map((flag) => flag.spelling);
    expect(diagnostic).toEqual(["--verbose", "--log-level", "--debug"]);
    for (const spelling of diagnostic) {
      expect(hasDiagnosticFlag([spelling])).toBe(true);
    }
  });

  test("matches attached and space forms of --log-level", () => {
    expect(hasDiagnosticFlag(["--log-level=info"])).toBe(true);
    expect(hasDiagnosticFlag(["--log-level", "info"])).toBe(true);
  });

  test("is false for non-diagnostic flags and value spellings", () => {
    expect(hasDiagnosticFlag([])).toBe(false);
    expect(hasDiagnosticFlag(["--trace", "--format=json"])).toBe(false);
    expect(hasDiagnosticFlag(["--verbose=true"])).toBe(false);
    expect(hasDiagnosticFlag(["--log-level=true"])).toBe(true);
  });
});

describe("landoFlagFooterLabels", () => {
  test("lists the footer labels in table order", () => {
    expect(landoFlagFooterLabels()).toEqual([
      "--format",
      "--json [fields]",
      "--jq",
      "--renderer",
      "--verbose",
      "--log-level",
      "--debug",
      "--trace",
    ]);
  });

  test("is derived from the table rows that carry a footer", () => {
    expect(landoFlagFooterLabels()).toEqual(
      LANDO_FLAGS.flatMap((flag) => (flag.footer === undefined ? [] : [flag.footer])),
    );
  });
});
