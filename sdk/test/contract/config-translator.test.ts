import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import { AbsolutePath, type LandofileShape, PortablePath } from "@lando/sdk/schema";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateInput,
  ConfigTranslatorShape,
} from "@lando/sdk/services";
import {
  type ConfigTranslatorContractHarness,
  ContractFailure,
  makeConfigTranslatorContractSuite,
  runConfigTranslatorContractSuite,
} from "@lando/sdk/test";

const APP_ROOT = AbsolutePath.make("/tmp/lando-config-translate-app");
const COMPOSE_FILE = Schema.decodeUnknownSync(PortablePath)("docker-compose.yml");

const detectsComposeFile = (input: ConfigTranslateDetectInput): boolean =>
  (input.files ?? []).some((file) => String(file).endsWith("docker-compose.yml"));

const mockTranslator: ConfigTranslatorShape = {
  id: "compose",
  summary: "Translate a docker-compose project into a Landofile fragment.",
  inputKinds: ["docker-compose"],
  detect: (input) =>
    Effect.succeed(
      detectsComposeFile(input)
        ? [{ translator: "compose", files: input.files ?? [], confidence: "likely" as const }]
        : [],
    ),
  translate: () =>
    Effect.succeed({
      fragment: { name: "myapp", recipe: "lamp" } satisfies Partial<LandofileShape>,
      diagnostics: [{ kind: "generated" as const, message: "Derived recipe from compose services." }],
    }),
};

const matchingInput: ConfigTranslateInput = {
  appRoot: APP_ROOT,
  files: [COMPOSE_FILE],
  current: {},
  options: {},
};

describe("ConfigTranslator contract", () => {
  test("a mock translator satisfies the required guarantees", async () => {
    const harness: ConfigTranslatorContractHarness = {
      name: "compose",
      translator: mockTranslator,
      matchingInput,
      nonMatchingInput: {
        appRoot: APP_ROOT,
        files: [Schema.decodeUnknownSync(PortablePath)("README.md")],
        current: {},
        options: {},
      },
      expectedFragment: { name: "myapp", recipe: "lamp" },
    };
    const exit = await Effect.runPromiseExit(runConfigTranslatorContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("optional options + mutation probes pass when supplied", async () => {
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({
        translator: mockTranslator,
        matchingInput,
        optionsSchema: Schema.Struct({ engine: Schema.String }),
        invalidOptions: { engine: 42 },
        mutationProbe: {
          snapshot: Effect.succeed("clean"),
          assertUnchanged: (before) => Effect.succeed(before === "clean"),
        },
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("a translator emitting an AppPlan-shaped fragment fails the contract", async () => {
    const bad: ConfigTranslatorShape = {
      ...mockTranslator,
      translate: () =>
        Effect.succeed({
          fragment: { appId: "x", plan: {} } as unknown as Partial<LandofileShape>,
          diagnostics: [],
        }),
    };
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({ translator: bad, matchingInput }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("a non-deterministic translator fails the contract", async () => {
    let counter = 0;
    const flaky: ConfigTranslatorShape = {
      ...mockTranslator,
      translate: () =>
        Effect.sync(() => {
          counter += 1;
          return {
            fragment: { name: `myapp-${counter}` } satisfies Partial<LandofileShape>,
            diagnostics: [],
          };
        }),
    };
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({ translator: flaky, matchingInput }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("makeConfigTranslatorContractSuite is an alias", () => {
    expect(makeConfigTranslatorContractSuite).toBe(runConfigTranslatorContractSuite);
  });

  test("ConfigTranslateError and ContractFailure are available", () => {
    expect(ConfigTranslateError).toBeDefined();
    expect(ContractFailure).toBeDefined();
  });
});
