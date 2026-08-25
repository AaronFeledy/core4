import { afterEach, describe, expect, test } from "bun:test";

import {
  activeJq,
  activeJsonControl,
  setActiveJq,
  setActiveJsonControl,
  setActiveResultFormat,
} from "../../src/cli/compiled-session.ts";
import { extractFormatFlags, resolveJsonControl } from "../../src/cli/format-flags.ts";

const JSON_CONTROL_OFF = { mode: "off" } as const;

afterEach(() => {
  setActiveJsonControl(JSON_CONTROL_OFF);
  setActiveJq(undefined);
  setActiveResultFormat("text");
});

describe("json control session", () => {
  test("defaults to off with no jq expression", () => {
    // Given a fresh compiled session.
    // When the exported session fields are read.
    // Then json control is off and jq is unset.
    expect(activeJsonControl).toEqual(JSON_CONTROL_OFF);
    expect(activeJq).toBeUndefined();
  });

  test("setActiveJsonControl and setActiveJq update session state", () => {
    // Given an explicit keys-mode control and a jq expression.
    const control = { mode: "keys", keys: ["core", "bun"] } as const;

    // When the session setters run.
    setActiveJsonControl(control);
    setActiveJq(".core");

    // Then the exported session fields match.
    expect(activeJsonControl).toEqual(control);
    expect(activeJq).toBe(".core");
  });
});

describe("resolveJsonControl", () => {
  test("returns off when --json is absent", () => {
    // Given argv with no json shortcut.
    const extracted = extractFormatFlags(["meta:version"]);

    // When control is resolved against the effective format.
    const control = resolveJsonControl(extracted, "text");

    // Then mode is off.
    expect(control).toEqual({ mode: "off" });
  });

  test("returns list when bare --json is present", () => {
    // Given a resolved command plus bare --json.
    const extracted = extractFormatFlags(["meta:version", "--json"]);

    // When control is resolved.
    const control = resolveJsonControl(extracted, "json");

    // Then mode is list.
    expect(control).toEqual({ mode: "list" });
  });

  test("returns keys when --json=k1,k2 is present", () => {
    // Given equals-form field list.
    const extracted = extractFormatFlags(["meta:version", "--json=core,bun"]);

    // When control is resolved.
    const control = resolveJsonControl(extracted, "json");

    // Then mode is keys with those fields.
    expect(control).toEqual({ mode: "keys", keys: ["core", "bun"] });
  });

  test("returns off for boolean-only -j", () => {
    // Given -j, which is a format shortcut rather than list-mode.
    const extracted = extractFormatFlags(["meta:version", "-j"]);

    // When control is resolved.
    const control = resolveJsonControl(extracted, "json");

    // Then mode stays off so the command still runs.
    expect(control).toEqual({ mode: "off" });
  });
});
