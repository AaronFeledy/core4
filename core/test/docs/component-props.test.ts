import { describe, expect, test } from "bun:test";

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
  assertAlpha2Component,
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
import { Either, JSONSchema, ParseResult, Schema } from "effect";

const expectRight = <A>(decoded: Either.Either<A, unknown>): A => {
  expect(decoded._tag).toBe("Right");
  if (Either.isLeft(decoded)) throw decoded.left;
  return decoded.right;
};

const expectNotImplemented = (decoded: Either.Either<unknown, unknown>, key: string) => {
  expect(decoded._tag).toBe("Left");
  if (Either.isRight(decoded)) return;
  expect(decoded.left).toBeInstanceOf(NotImplementedError);
  expect(decoded.left).toMatchObject({ _tag: "NotImplementedError" });
  expect(String(decoded.left.message)).toContain(key);
  expect(String(decoded.left.remediation)).toContain("Unsupported guide component prop");
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

  test("accepts Scenario props, applies render default, and rejects deferred e2e layer", () => {
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
    expect(missingReason._tag).toBe("Left");
    if (Either.isLeft(missingReason)) {
      expect(missingReason.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(missingReason.left);
      expect(issues.map((issue) => issue.message)).toContain(
        "<Scenario render={false}> requires a `reason` of at least 8 characters.",
      );
    }

    const missingId = decodeScenarioPropsEither({ render: false });
    expect(missingId._tag).toBe("Left");
    if (Either.isLeft(missingId)) {
      expect(missingId.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(missingId.left);
      expect(issues.some((issue) => issue.path.includes("id"))).toBe(true);
    }

    expectNotImplemented(decodeScenarioPropsEither({ id: "reader", layer: "e2e" }), "layer");
  });

  test("accepts Run command or shell and rejects runtime/tooling variants", () => {
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

    const both = decodeRunPropsEither({ command: "lando start", shell: "lando start" });
    expect(both._tag).toBe("Left");
    if (Either.isLeft(both)) {
      expect(both.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(both.left);
      expect(issues.map((issue) => issue.message)).toContain(
        "<Run> requires exactly one of `command` or `shell`.",
      );
    }

    const invalidAnswers = decodeRunPropsEither({ command: "lando start", answers: { name: 123 } });
    expect(invalidAnswers._tag).toBe("Left");
    if (Either.isLeft(invalidAnswers)) {
      expect(invalidAnswers.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(invalidAnswers.left);
      expect(issues.some((issue) => issue.path.join(".") === "answers.name")).toBe(true);
    }

    expectNotImplemented(decodeRunPropsEither({ runtime: "appStart" }), "runtime");
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
    expect(multipleTargets._tag).toBe("Left");
    if (Either.isLeft(multipleTargets)) {
      expect(multipleTargets.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(multipleTargets.left);
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

    expect(decodeInspectPropsEither({ events: false })._tag).toBe("Left");
    expect(decodeInspectPropsEither({ output: false })._tag).toBe("Left");

    const none = decodeInspectPropsEither({});
    expect(none._tag).toBe("Left");
    if (Either.isLeft(none)) {
      expect(none.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(none.left);
      expect(issues.map((issue) => issue.message)).toContain(
        "<Inspect> requires exactly one of `file`, `json`, `events`, or `output`.",
      );
    }

    const multiple = decodeInspectPropsEither({ file: "package.json", output: true });
    expect(multiple._tag).toBe("Left");
    if (Either.isLeft(multiple)) {
      expect(multiple.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(multiple.left);
      expect(issues.map((issue) => issue.message)).toContain(
        "<Inspect> requires exactly one of `file`, `json`, `events`, or `output`.",
      );
    }
  });

  test("round-trips every component schema through encode/decode and JSON Schema", () => {
    const examples = [
      ["GuideProps", GuideProps, {}],
      ["ScenarioProps", ScenarioProps, { id: "reader", render: true }],
      ["StepProps", StepProps, { name: "start-app" }],
      ["RunProps", RunProps, { command: "lando start" }],
      ["VerifyProps", VerifyProps, { event: "post-start", expect: { regex: "ready" } }],
      ["CleanupProps", CleanupProps, {}],
      ["VariableProps", VariableProps, { name: "siteName", value: "node-postgres" }],
      ["HiddenProps", HiddenProps, { reason: "prepare shared context" }],
      ["InspectProps", InspectProps, { file: "package.json" }],
      ["UseFixtureProps", UseFixtureProps, { name: "invalid-service-type" }],
      ["TabsProps", TabsProps, { axis: "default" }],
      ["TabProps", TabProps, { name: "linux" }],
      ["MatcherSchema", MatcherSchema, { anyOf: ["ready", { not: false }] }],
    ] as const;

    for (const [name, schema, value] of examples) {
      const decoded = Schema.decodeUnknownSync(schema)(value);
      expect(Schema.encodeSync(schema)(decoded)).toEqual(value);
      expect(JSONSchema.make(schema)).toHaveProperty(["$defs", name]);
    }
  });

  test("accepts Hidden props and rejects reasons shorter than eight characters", () => {
    expect(expectRight(decodeHiddenPropsEither({ reason: "seed deterministic state" }))).toEqual({
      reason: "seed deterministic state",
    });

    const shortReason = decodeHiddenPropsEither({ reason: "short" });
    expect(shortReason._tag).toBe("Left");
    if (Either.isLeft(shortReason)) {
      expect(shortReason.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(shortReason.left);
      expect(issues.some((issue) => issue.path.includes("reason"))).toBe(true);
    }

    const missingReason = decodeHiddenPropsEither({});
    expect(missingReason._tag).toBe("Left");
  });

  test("accepts Tabs props with optional axis and rejects unknown keys", () => {
    expect(expectRight(decodeTabsPropsEither({}))).toEqual({});
    expect(expectRight(decodeTabsPropsEither({ axis: "default" }))).toEqual({ axis: "default" });

    const badAxis = decodeTabsPropsEither({ axis: "Default" });
    expect(badAxis._tag).toBe("Left");
    if (Either.isLeft(badAxis)) {
      expect(badAxis.left).toBeInstanceOf(ParseResult.ParseError);
    }

    const excess = decodeTabsPropsEither({ name: "linux" });
    expect(excess._tag).toBe("Left");
  });

  test("accepts Tab props with a kebab name and rejects missing or malformed names", () => {
    expect(expectRight(decodeTabPropsEither({ name: "linux" }))).toEqual({ name: "linux" });
    expect(expectRight(decodeTabPropsEither({ name: "drupal-10" }))).toEqual({ name: "drupal-10" });

    const missing = decodeTabPropsEither({});
    expect(missing._tag).toBe("Left");
    if (Either.isLeft(missing)) {
      expect(missing.left).toBeInstanceOf(ParseResult.ParseError);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(missing.left);
      expect(issues.some((issue) => issue.path.includes("name"))).toBe(true);
    }

    const malformed = decodeTabPropsEither({ name: "Linux" });
    expect(malformed._tag).toBe("Left");

    const legacyValueRejected = decodeTabPropsEither({ value: "linux" });
    expect(legacyValueRejected._tag).toBe("Left");
  });

  test.each(["Bogus", "NotAComponent"] as const)(
    "assertAlpha2Component rejects unknown component <%s>",
    (componentName) => {
      try {
        assertAlpha2Component(componentName, "docs/guides/node-postgres.mdx");
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
  ] as const)("assertAlpha2Component accepts supported component <%s>", (componentName) => {
    expect(assertAlpha2Component(componentName, "docs/guides/node-postgres.mdx")).toBeUndefined();
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
    expect(shortJustification._tag).toBe("Left");
    const missingCode = decodeInlinePropsEither({ justification: "explains the omitted code" });
    expect(missingCode._tag).toBe("Left");

    expect(JSONSchema.make(InlineProps)).toBeDefined();
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
    expect(shortReason._tag).toBe("Left");
    const missingReason = decodeSkipPropsEither({ until: "v4.1.0" });
    expect(missingReason._tag).toBe("Left");

    expect(JSONSchema.make(SkipProps)).toBeDefined();
  });
});
