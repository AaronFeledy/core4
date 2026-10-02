import { describe, expect, test } from "bun:test";
import { SchemaIssue } from "effect";

import {
  CleanupProps,
  GuideProps,
  HiddenProps,
  InlineProps,
  InspectProps,
  MatcherSchema,
  RunProps,
  ScenarioProps,
  SkipProps,
  StepProps,
  TabProps,
  TabsProps,
  UseFixtureProps,
  VariableProps,
  VerifyProps,
  assertSupportedGuideComponent,
  decodeHiddenPropsEither,
  decodeInlinePropsEither,
  decodeInspectPropsEither,
  decodeRunPropsEither,
  decodeScenarioPropsEither,
  decodeSkipPropsEither,
  decodeTabPropsEither,
  decodeTabsPropsEither,
  decodeVerifyPropsEither,
} from "@lando/core/docs/components";
import { NotImplementedError } from "@lando/sdk/errors";
import { Result, Schema } from "effect";

const expectRight = <A>(decoded: Result.Result<A, unknown>): A => {
  expect(decoded._tag).toBe("Success");
  if (Result.isFailure(decoded)) throw decoded.failure;
  return decoded.success;
};

const expectNotImplemented = (decoded: Result.Result<unknown, unknown>, key: string) => {
  expect(decoded._tag).toBe("Failure");
  if (Result.isSuccess(decoded)) return;
  const left = decoded.failure;
  expect(left).toBeInstanceOf(NotImplementedError);
  if (!(left instanceof NotImplementedError)) throw left;
  expect(left).toMatchObject({ _tag: "NotImplementedError" });
  expect(String(left.message)).toContain(key);
  expect(String(left.remediation)).toContain("Unsupported guide component prop");
};

const expectParseError = (decoded: Result.Result<unknown, unknown>): Schema.SchemaError => {
  expect(decoded._tag).toBe("Failure");
  if (Result.isSuccess(decoded)) throw decoded.success;
  expect(decoded.failure).toBeInstanceOf(Schema.SchemaError);
  if (!(decoded.failure instanceof Schema.SchemaError)) throw decoded.failure;
  return decoded.failure;
};

describe("component prop schemas", () => {
  test("accepts Guide, Step, Cleanup, Variable, Hidden, and UseFixture props", () => {
    expect(Schema.decodeUnknownSync(GuideProps)({})).toEqual({});
    expect(Schema.decodeUnknownSync(StepProps)({ name: "install-deps" })).toEqual({ name: "install-deps" });
    expect(Schema.decodeUnknownSync(CleanupProps)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(VariableProps)({ name: "siteName", value: "my-app", display: "~/my-app" }),
    ).toEqual({
      name: "siteName",
      value: "my-app",
      display: "~/my-app",
    });
    expect(Schema.decodeUnknownSync(HiddenProps)({ reason: "sets up deterministic state" })).toEqual({
      reason: "sets up deterministic state",
    });
    expect(Schema.decodeUnknownSync(UseFixtureProps)({ name: "invalid-service-type" })).toEqual({
      name: "invalid-service-type",
    });
  });

  test("accepts Scenario props, applies render default, and validates layer values", () => {
    expect(expectRight(decodeScenarioPropsEither({ id: "reader", tags: ["smoke"] }))).toEqual({
      id: "reader",
      tags: ["smoke"],
      render: true,
    });
    expect(
      expectRight(
        decodeScenarioPropsEither({ id: "invalid-landofile", render: false, reason: "covers parse errors" }),
      ),
    ).toEqual({
      id: "invalid-landofile",
      render: false,
      reason: "covers parse errors",
    });

    const missingReason = decodeScenarioPropsEither({ id: "hidden", render: false });
    expect(missingReason._tag).toBe("Failure");
    if (Result.isFailure(missingReason)) {
      expect(missingReason.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(
        expectParseError(missingReason).issue,
      ).issues;
      expect(issues.map((issue) => issue.message)).toContain(
        "<Scenario render={false}> requires a `reason` of at least 8 characters.",
      );
    }

    const missingId = decodeScenarioPropsEither({ render: false });
    expect(missingId._tag).toBe("Failure");
    if (Result.isFailure(missingId)) {
      expect(missingId.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(missingId).issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("id"))).toBe(true);
    }

    expect(expectRight(decodeScenarioPropsEither({ id: "reader", layer: "e2e", tags: ["@smoke"] }))).toEqual({
      id: "reader",
      layer: "e2e",
      tags: ["@smoke"],
      render: true,
    });

    const invalidLayer = decodeScenarioPropsEither({ id: "reader", layer: "unit" });
    expect(invalidLayer._tag).toBe("Failure");
    if (Result.isFailure(invalidLayer)) expect(invalidLayer.failure).toBeInstanceOf(Schema.SchemaError);
  });

  test("accepts Run command, shell, and library forms while rejecting invalid variants", () => {
    expect(
      expectRight(decodeRunPropsEither({ command: "lando start", answers: { name: "node-postgres" } })),
    ).toEqual({
      command: "lando start",
      answers: { name: "node-postgres" },
    });
    expect(expectRight(decodeRunPropsEither({ shell: "echo ok", expectExit: 0 }))).toEqual({
      shell: "echo ok",
      expectExit: 0,
    });
    expect(
      expectRight(
        decodeRunPropsEither({
          runtime: "library",
          code: "expect(true).toBe(true);",
          displayCode: "await Effect.runPromise(...)",
        }),
      ),
    ).toEqual({
      runtime: "library",
      code: "expect(true).toBe(true);",
      displayCode: "await Effect.runPromise(...)",
    });

    const both = decodeRunPropsEither({ command: "lando start", shell: "lando start" });
    expect(both._tag).toBe("Failure");
    if (Result.isFailure(both)) {
      expect(both.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(both).issue).issues;
      expect(
        issues.some(
          (issue) =>
            issue.message === "Expected no excess property" && (issue.path ?? []).join(".") === "shell",
        ),
      ).toBe(true);
      expect(
        issues.some(
          (issue) =>
            issue.message === "Expected no excess property" && (issue.path ?? []).join(".") === "command",
        ),
      ).toBe(true);
    }

    const invalidAnswers = decodeRunPropsEither({ command: "lando start", answers: { name: 123 } });
    expect(invalidAnswers._tag).toBe("Failure");
    if (Result.isFailure(invalidAnswers)) {
      expect(invalidAnswers.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(
        expectParseError(invalidAnswers).issue,
      ).issues;
      expect(issues.some((issue) => (issue.path ?? []).join(".") === "answers.name")).toBe(true);
    }

    const excess = decodeRunPropsEither({ command: "lando start", extra: true });
    expect(excess._tag).toBe("Failure");
    if (Result.isFailure(excess)) {
      expect(excess.failure).toBeInstanceOf(Schema.SchemaError);
    }

    const unsupportedRuntime = decodeRunPropsEither({ runtime: "appStart", code: "x", displayCode: "y" });
    expect(unsupportedRuntime._tag).toBe("Failure");
    if (Result.isFailure(unsupportedRuntime)) {
      expect(unsupportedRuntime.failure).toBeInstanceOf(Schema.SchemaError);
      expect(unsupportedRuntime.failure).not.toBeInstanceOf(NotImplementedError);
    }

    const missingCode = decodeRunPropsEither({ runtime: "library", displayCode: "y" });
    expect(missingCode._tag).toBe("Failure");
    if (Result.isFailure(missingCode)) {
      expect(missingCode.failure).toBeInstanceOf(Schema.SchemaError);
    }

    const missingDisplayCode = decodeRunPropsEither({ runtime: "library", code: "x" });
    expect(missingDisplayCode._tag).toBe("Failure");
    if (Result.isFailure(missingDisplayCode)) {
      expect(missingDisplayCode.failure).toBeInstanceOf(Schema.SchemaError);
    }

    const commandAndRuntime = decodeRunPropsEither({
      command: "lando start",
      runtime: "library",
      code: "x",
      displayCode: "y",
    });
    expect(commandAndRuntime._tag).toBe("Failure");
    if (Result.isFailure(commandAndRuntime)) {
      expect(commandAndRuntime.failure).toBeInstanceOf(Schema.SchemaError);
    }

    expectNotImplemented(decodeRunPropsEither({ tooling: "npm" }), "tooling");
  });

  test("accepts Verify targets and matcher subset", () => {
    expect(
      expectRight(decodeVerifyPropsEither({ event: "post-start", expect: { regex: "started" } })),
    ).toEqual({
      event: "post-start",
      expect: { regex: "started" },
    });
    expect(expectRight(decodeVerifyPropsEither({ file: "package.json", expect: { name: "app" } }))).toEqual({
      file: "package.json",
      expect: { name: "app" },
    });
    expect(
      expectRight(decodeVerifyPropsEither({ errorTag: "LandofileValidationError", expect: { not: false } })),
    ).toEqual({
      errorTag: "LandofileValidationError",
      expect: { not: false },
    });
    expect(Schema.decodeUnknownSync(MatcherSchema)({ anyOf: ["ok", { schema: "LandofileShape" }] })).toEqual({
      anyOf: ["ok", { schema: "LandofileShape" }],
    });

    const multipleTargets = decodeVerifyPropsEither({ event: "post-start", file: "lando.yml" });
    expect(multipleTargets._tag).toBe("Failure");
    if (Result.isFailure(multipleTargets)) {
      expect(multipleTargets.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(
        expectParseError(multipleTargets).issue,
      ).issues;
      expect(issues.map((issue) => issue.message)).toContain("<Verify> requires exactly one target.");
    }

    expectNotImplemented(decodeVerifyPropsEither({ command: "lando start", runtime: "appStart" }), "runtime");
    expectNotImplemented(decodeVerifyPropsEither({ command: "lando start", tooling: "npm" }), "tooling");
    expectNotImplemented(
      decodeVerifyPropsEither({ command: "lando start", expect: { exact: { ok: true } } }),
      "exact",
    );
    expectNotImplemented(
      decodeVerifyPropsEither({ command: "lando start", expect: { allOf: [true] } }),
      "allOf",
    );
    expectNotImplemented(
      decodeVerifyPropsEither({ command: "lando start", expect: { oneOf: [true] } }),
      "oneOf",
    );
  });

  test("accepts a single Inspect target and rejects zero or multiple targets", () => {
    expect(expectRight(decodeInspectPropsEither({ file: "package.json" }))).toEqual({
      file: "package.json",
    });
    expect(expectRight(decodeInspectPropsEither({ json: "lando.yml" }))).toEqual({ json: "lando.yml" });
    expect(expectRight(decodeInspectPropsEither({ events: true }))).toEqual({ events: true });
    expect(expectRight(decodeInspectPropsEither({ output: true }))).toEqual({ output: true });

    expect(decodeInspectPropsEither({ events: false })._tag).toBe("Failure");
    expect(decodeInspectPropsEither({ output: false })._tag).toBe("Failure");

    const none = decodeInspectPropsEither({});
    expect(none._tag).toBe("Failure");
    if (Result.isFailure(none)) {
      expect(none.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(none).issue).issues;
      expect(issues.map((issue) => issue.message)).toContain(
        "<Inspect> requires exactly one of `file`, `json`, `events`, or `output`.",
      );
    }

    const multiple = decodeInspectPropsEither({ file: "package.json", output: true });
    expect(multiple._tag).toBe("Failure");
    if (Result.isFailure(multiple)) {
      expect(multiple.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(multiple).issue).issues;
      expect(issues.map((issue) => issue.message)).toContain(
        "<Inspect> requires exactly one of `file`, `json`, `events`, or `output`.",
      );
    }
  });

  test("round-trips every component schema through encode/decode and JSON Schema", () => {
    const expectSchemaRoundTrip = <S extends Schema.Codec<unknown, unknown>>(
      name: string,
      schema: S,
      value: S["Encoded"],
    ) => {
      const decoded = Schema.decodeUnknownSync(schema)(value);
      expect(Schema.encodeSync(schema)(decoded)).toEqual(value);
      expect(Schema.toJsonSchemaDocument(schema)).toHaveProperty(["definitions", name]);
    };

    expectSchemaRoundTrip("GuideProps", GuideProps, {});
    expectSchemaRoundTrip("ScenarioProps", ScenarioProps, { id: "reader", render: true });
    expectSchemaRoundTrip("StepProps", StepProps, { name: "start-app" });
    expectSchemaRoundTrip("RunProps", RunProps, { command: "lando start" });
    expectSchemaRoundTrip("VerifyProps", VerifyProps, { event: "post-start", expect: { regex: "ready" } });
    expectSchemaRoundTrip("CleanupProps", CleanupProps, {});
    expectSchemaRoundTrip("VariableProps", VariableProps, { name: "siteName", value: "node-postgres" });
    expectSchemaRoundTrip("HiddenProps", HiddenProps, { reason: "prepare shared context" });
    expectSchemaRoundTrip("InspectProps", InspectProps, { file: "package.json" });
    expectSchemaRoundTrip("UseFixtureProps", UseFixtureProps, { name: "invalid-service-type" });
    expectSchemaRoundTrip("TabsProps", TabsProps, { axis: "default" });
    expectSchemaRoundTrip("TabProps", TabProps, { name: "linux" });
    expectSchemaRoundTrip("MatcherSchema", MatcherSchema, { anyOf: ["ready", { not: false }] });
  });

  test("accepts Hidden props and rejects reasons shorter than eight characters", () => {
    expect(expectRight(decodeHiddenPropsEither({ reason: "seed deterministic state" }))).toEqual({
      reason: "seed deterministic state",
    });

    const shortReason = decodeHiddenPropsEither({ reason: "short" });
    expect(shortReason._tag).toBe("Failure");
    if (Result.isFailure(shortReason)) {
      expect(shortReason.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(shortReason).issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("reason"))).toBe(true);
    }

    const missingReason = decodeHiddenPropsEither({});
    expect(missingReason._tag).toBe("Failure");
  });

  test("accepts Tabs props with optional axis and rejects unknown keys", () => {
    expect(expectRight(decodeTabsPropsEither({}))).toEqual({});
    expect(expectRight(decodeTabsPropsEither({ axis: "default" }))).toEqual({ axis: "default" });

    const badAxis = decodeTabsPropsEither({ axis: "Default" });
    expect(badAxis._tag).toBe("Failure");
    if (Result.isFailure(badAxis)) {
      expect(badAxis.failure).toBeInstanceOf(Schema.SchemaError);
    }

    const excess = decodeTabsPropsEither({ name: "linux" });
    expect(excess._tag).toBe("Failure");
  });

  test("accepts Tab props with a kebab name and rejects missing or malformed names", () => {
    expect(expectRight(decodeTabPropsEither({ name: "linux" }))).toEqual({ name: "linux" });
    expect(expectRight(decodeTabPropsEither({ name: "drupal-10" }))).toEqual({ name: "drupal-10" });

    const missing = decodeTabPropsEither({});
    expect(missing._tag).toBe("Failure");
    if (Result.isFailure(missing)) {
      expect(missing.failure).toBeInstanceOf(Schema.SchemaError);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(expectParseError(missing).issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("name"))).toBe(true);
    }

    const malformed = decodeTabPropsEither({ name: "Linux" });
    expect(malformed._tag).toBe("Failure");

    const legacyValueRejected = decodeTabPropsEither({ value: "linux" });
    expect(legacyValueRejected._tag).toBe("Failure");
  });

  test.each(["Bogus", "NotAComponent"] as const)(
    "assertSupportedGuideComponent rejects unknown component <%s>",
    (componentName) => {
      try {
        assertSupportedGuideComponent(componentName, "docs/guides/node-postgres.mdx");
        throw new Error(`expected ${componentName} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(NotImplementedError);
        if (!(error instanceof NotImplementedError)) return;
        expect(error.commandId).toBe(`guide.component.${componentName.toLowerCase()}`);
        expect(error.remediation).toBe(`<${componentName}> is not supported yet.`);
      }
    },
  );

  test.each([
    "Guide",
    "Scenario",
    "Step",
    "Run",
    "Verify",
    "Cleanup",
    "Variable",
    "UseFixture",
    "Inspect",
    "Tabs",
    "Tab",
    "Hidden",
    "Inline",
    "Skip",
  ] as const)("assertSupportedGuideComponent accepts supported component <%s>", (componentName) => {
    expect(assertSupportedGuideComponent(componentName, "docs/guides/node-postgres.mdx")).toBeUndefined();
  });

  test("accepts Inline props, applies lang default, and requires justification >= 8 chars", () => {
    expect(
      expectRight(
        decodeInlinePropsEither({ code: "const x = 1;", justification: "shows the config object" }),
      ),
    ).toEqual({ code: "const x = 1;", lang: "ts", justification: "shows the config object" });
    expect(
      expectRight(
        decodeInlinePropsEither({ code: "print(1)", lang: "py", justification: "python sample only" }),
      ),
    ).toEqual({ code: "print(1)", lang: "py", justification: "python sample only" });

    const shortJustification = decodeInlinePropsEither({ code: "x", justification: "tiny" });
    expect(shortJustification._tag).toBe("Failure");
    const missingCode = decodeInlinePropsEither({ justification: "explains the omitted code" });
    expect(missingCode._tag).toBe("Failure");

    expect(Schema.toJsonSchemaDocument(InlineProps)).toBeDefined();
  });

  test("accepts Skip props, requires reason >= 8 chars, and allows optional until", () => {
    expect(expectRight(decodeSkipPropsEither({ reason: "awaiting upstream fix" }))).toEqual({
      reason: "awaiting upstream fix",
    });
    expect(expectRight(decodeSkipPropsEither({ reason: "blocked on flaky CI", until: "v4.1.0" }))).toEqual({
      reason: "blocked on flaky CI",
      until: "v4.1.0",
    });

    const shortReason = decodeSkipPropsEither({ reason: "soon" });
    expect(shortReason._tag).toBe("Failure");
    const missingReason = decodeSkipPropsEither({ until: "v4.1.0" });
    expect(missingReason._tag).toBe("Failure");

    expect(Schema.toJsonSchemaDocument(SkipProps)).toBeDefined();
  });
});
