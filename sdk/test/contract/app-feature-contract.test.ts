import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { AppFeatureDefinition } from "@lando/sdk/services";
import { type AppFeatureContractHarness, ContractFailure, runAppFeatureContract } from "@lando/sdk/test";

const services: AppFeatureContractHarness["services"] = [
  { serviceName: "php", serviceType: "php", framework: "drupal" },
  { serviceName: "node", serviceType: "node" },
];

const expectAppFeatureFailure = async (
  harness: AppFeatureContractHarness,
  assertion: string,
): Promise<void> => {
  const result = await Effect.runPromiseExit(runAppFeatureContract(harness));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("runAppFeatureContract", () => {
  test("passes for a Mailpit-style feature selecting php and injecting SMTP env", async () => {
    const mailpit: AppFeatureDefinition = {
      id: "mailpit.smtp",
      priority: 100,
      activatedBy: { services: { type: "php" } },
      selectors: { types: ["php"] },
      requires: { globalServices: ["mailpit"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => {
            service.addEnv("MAIL_HOST", "mailpit.global.internal");
            service.addEnv("MAIL_PORT", "1025");
          });
        }),
    };

    const result = await Effect.runPromiseExit(runAppFeatureContract({ feature: mailpit, services }));

    expect(result._tag).toBe("Success");
  });

  test("passes for a feature that mutates only non-env fields", async () => {
    const commandOnly: AppFeatureDefinition = {
      id: "command-only",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => service.setCommand(["sleep", "infinity"]));
        }),
    };

    const result = await Effect.runPromiseExit(runAppFeatureContract({ feature: commandOnly, services }));

    expect(result._tag).toBe("Success");
  });

  test("fails when a feature inspects provider capabilities", async () => {
    const leaky: AppFeatureDefinition = {
      id: "capability-leak",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          void (ctx as unknown as { capabilities?: unknown }).capabilities;
          ctx.forEachSelected((service) => service.addEnv("X", "1"));
        }),
    };

    await expectAppFeatureFailure(
      { feature: leaky, services },
      "app feature does not inspect provider capabilities",
    );
  });

  test("fails when a feature writes divergent values to the same env key", async () => {
    const divergent: AppFeatureDefinition = {
      id: "divergent",
      priority: 100,
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => {
            service.addEnv("K", "one");
            service.addEnv("K", "two");
          });
        }),
    };

    await expectAppFeatureFailure(
      { feature: divergent, services },
      "app feature mutations are idempotent (no divergent writes)",
    );
  });

  test("fails when selectors match no seeded service", async () => {
    const unmatched: AppFeatureDefinition = {
      id: "unmatched",
      priority: 100,
      selectors: { types: ["mysql"] },
      apply: (ctx) => Effect.sync(() => ctx.forEachSelected((service) => service.addEnv("X", "1"))),
    };

    await expectAppFeatureFailure(
      { feature: unmatched, services },
      "app feature selectors match at least one service draft",
    );
  });

  test("passes as a verified no-op when activation matches no seeded service", async () => {
    const inactive: AppFeatureDefinition = {
      id: "inactive-mailpit",
      priority: 100,
      activatedBy: { services: { type: "python" } },
      selectors: { types: ["php"] },
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.forEachSelected((service) => service.addEnv("SHOULD_NOT_MUTATE", "1"));
        }),
    };

    const result = await Effect.runPromiseExit(
      runAppFeatureContract({ feature: inactive, services, expectNoActivation: true }),
    );

    expect(result._tag).toBe("Success");
  });

  test("fails when inactive feature declares malformed global service requirements", async () => {
    const inactive = {
      id: "inactive-malformed-requires",
      priority: 100,
      activatedBy: { services: { type: "python" } },
      selectors: { types: ["php"] },
      requires: { globalServices: [""] },
      apply: () => Effect.void,
    } as unknown as AppFeatureDefinition;

    await expectAppFeatureFailure(
      { feature: inactive, services, expectNoActivation: true },
      "app feature requires.globalServices entries are non-empty ids",
    );
  });
});
