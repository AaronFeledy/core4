import { describe, expect, test } from "bun:test";

import {
  CleanupProps,
  GuideProps,
  HiddenProps,
  MatcherSchema,
  RunProps,
  ScenarioProps,
  StepProps,
  UseFixtureProps,
  VariableProps,
  VerifyProps,
  decodeRunPropsEither,
  decodeScenarioPropsEither,
  decodeVerifyPropsEither,
  hiddenComponentNotImplemented,
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
  expect(String(decoded.left.remediation)).toContain("Phase 3 Beta");
  expect(String(decoded.left.remediation)).toContain("spec/ROADMAP.md");
};

describe("Alpha 2 component prop schemas", () => {
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
    if (Either.isLeft(missingReason)) expect(missingReason.left).toBeInstanceOf(ParseResult.ParseError);
    expectNotImplemented(decodeScenarioPropsEither({ id: "reader", layer: "e2e" }), "layer");
  });

  test("accepts Run command or shell and rejects Beta runtime/tooling variants", () => {
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
    if (Either.isLeft(both)) expect(both.left).toBeInstanceOf(NotImplementedError);
    expectNotImplemented(decodeRunPropsEither({ runtime: "appStart" }), "runtime");
    expectNotImplemented(decodeRunPropsEither({ tooling: "npm" }), "tooling");
  });

  test("accepts Verify targets and Alpha 2 matcher subset", () => {
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
    if (Either.isLeft(multipleTargets)) expect(multipleTargets.left).toBeInstanceOf(NotImplementedError);
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
      ["UseFixtureProps", UseFixtureProps, { name: "invalid-service-type" }],
      ["MatcherSchema", MatcherSchema, { anyOf: ["ready", { not: false }] }],
    ] as const;

    for (const [name, schema, value] of examples) {
      const decoded = Schema.decodeUnknownSync(schema)(value);
      expect(Schema.encodeSync(schema)(decoded)).toEqual(value);
      expect(JSONSchema.make(schema)).toHaveProperty(["$defs", name]);
    }
  });

  test("exposes Hidden generator rejection helper", () => {
    const failure = hiddenComponentNotImplemented();
    expect(failure).toBeInstanceOf(NotImplementedError);
    expect(failure).toMatchObject({ commandId: "guide.component.hidden", specSection: "§19.3" });
    expect(failure.remediation).toContain("<Scenario render={false}>");
  });
});
