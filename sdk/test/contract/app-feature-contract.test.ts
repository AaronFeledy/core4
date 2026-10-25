import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import type { AppFeatureDefinition } from "@lando/sdk/services";
import { type AppFeatureContractHarness, ContractFailure, runAppFeatureContract } from "@lando/sdk/test";

type DeclareEndpoints = NonNullable<AppFeatureDefinition["declareEndpoints"]>;

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
  expect(result.cause.reasons).toHaveLength(1);
  const reason = result.cause.reasons[0];
  if (reason === undefined) throw new Error("expected a failure reason");
  expect(Cause.isFailReason(reason)).toBe(true);
  if (!Cause.isFailReason(reason)) return;
  expect(reason.error).toBeInstanceOf(ContractFailure);
  expect(reason.error._tag).toBe("ContractFailure");
  expect(reason.error.assertion).toBe(assertion);
};

const expectDeclarationFailure = (declareEndpoints: DeclareEndpoints, assertion: string) =>
  expectAppFeatureFailure(
    {
      feature: {
        id: "declaration",
        priority: 100,
        selectors: { types: ["php"] },
        declareEndpoints,
        apply: () => Effect.void,
      },
      services: [
        {
          serviceName: "php",
          serviceType: "php",
          connection: {
            family: "postgres",
            port: 5432,
            creds: { user: "app", password: "secret", database: "app" },
          },
        },
        { serviceName: "node", serviceType: "node" },
      ],
    },
    assertion,
  );

describe("runAppFeatureContract", () => {
  test.each(["config", "normalizedConfig", "connection", "primary", "featureIds"] as const)(
    "rejects declaration mutation of %s",
    async (field) => {
      // Given
      const declare: DeclareEndpoints = (ctx) =>
        Effect.sync(() => {
          const service = ctx.selected[0];
          if (service === undefined) throw new Error("Missing selected fixture service");
          switch (field) {
            case "config":
              Reflect.set(ctx.config, "port", 9000);
              break;
            case "normalizedConfig":
              Reflect.set(service.normalizedConfig, "port", 9000);
              break;
            case "connection":
              if (service.connection === undefined) throw new Error("Missing fixture connection");
              Reflect.set(service.connection.creds, "user", "changed");
              break;
            case "primary":
              Reflect.set(service, "primary", true);
              break;
            case "featureIds":
              Reflect.set(service.featureIds, "0", "changed");
              break;
            default:
              field satisfies never;
          }
          return { php: [{ _tag: "internal" as const, protocol: "http" as const, port: 8080 }] };
        });
      // When / Then
      await expectDeclarationFailure(declare, "app feature endpoint declaration facts are immutable");
    },
  );

  test("rejects input mutation on the repeated declaration invocation", async () => {
    // Given
    let invocation = 0;
    const declare: DeclareEndpoints = (ctx) =>
      Effect.sync(() => {
        if (++invocation === 2) Reflect.set(ctx.config, "port", 9000);
        return { php: [{ _tag: "internal" as const, protocol: "http" as const, port: 8080 }] };
      });
    // When / Then
    await expectDeclarationFailure(declare, "app feature endpoint declaration facts are immutable");
  });

  test("rejects schema-invalid app endpoint publication", async () => {
    // Given
    const declare: DeclareEndpoints = () =>
      Effect.succeed({
        php: [{ _tag: "published", protocol: "http", port: 8080, publication: { hostPort: 0 } }],
      });
    // When / Then
    await expectDeclarationFailure(declare, "app feature endpoint declarations match EndpointPlan");
  });

  test("rejects app declaration realization metadata", async () => {
    // Given
    const declare: DeclareEndpoints = () =>
      Effect.succeed({ php: [{ _tag: "internal", protocol: "http", port: 8080, realization: "host" }] });
    // When / Then
    await expectDeclarationFailure(
      declare,
      "app feature emits endpoint intent without realization decisions",
    );
  });

  test.each(["throw", "defect"] as const)(
    "reports an app declaration %s as ContractFailure",
    async (failure) => {
      // Given
      const declare: DeclareEndpoints = () => {
        if (failure === "throw") throw new Error("Declaration fixture failure");
        return Effect.die("Declaration fixture defect");
      };
      // When / Then
      await expectDeclarationFailure(declare, "endpoint declaration succeeds");
    },
  );
  test("accepts declaration-only app features without application mutators", async () => {
    // Given
    const feature: AppFeatureDefinition = {
      id: "declared-listener",
      priority: 100,
      selectors: { types: ["php"] },
      declareEndpoints: (ctx) => {
        expect("forEachSelected" in ctx).toBe(false);
        return Effect.succeed({ php: [{ _tag: "internal", protocol: "http", port: 8080 }] });
      },
      apply: () => Effect.void,
    };
    // When
    const result = await Effect.runPromiseExit(runAppFeatureContract({ feature, services }));
    // Then
    expect(result._tag).toBe("Success");
  });

  test("rejects unstable app endpoint declarations", async () => {
    // Given
    let port = 8080;
    const declare: DeclareEndpoints = () =>
      Effect.sync(() => ({ php: [{ _tag: "internal", protocol: "http", port: port++ }] }));
    // When / Then
    await expectDeclarationFailure(declare, "app feature endpoint declarations are deterministic");
  });

  test("rejects app endpoint declarations for unselected services", async () => {
    // Given
    const declare: DeclareEndpoints = () =>
      Effect.succeed({ node: [{ _tag: "internal", protocol: "http", port: 8080 }] });
    // When / Then
    await expectDeclarationFailure(declare, "app feature declares endpoints only for selected services");
  });
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
