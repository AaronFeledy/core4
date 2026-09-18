import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { MailpitMsmtpBaseFamilyError } from "@lando/sdk/errors";
import { ServiceConfig } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ServiceBuildStepIntent,
} from "@lando/sdk/services";

import { mailpitWireFeature } from "../src/app-features/mailpit.ts";
import { PHP_FEATURE_ID } from "../src/services/php.ts";

const unsupported = (name: string) => () => {
  throw new Error(`unexpected mutator ${name}`);
};

const view = (
  serviceName: string,
  serviceType: string,
  config: Record<string, unknown>,
  featureIds: ReadonlyArray<string> = [],
): AppFeatureServiceView => ({
  serviceName,
  serviceType,
  base: "lando",
  primary: false,
  featureIds,
  normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)(config),
});

const applyWire = (views: ReadonlyArray<AppFeatureServiceView>) => {
  const steps: ServiceBuildStepIntent[] = [];
  const mutatorsFor = (target: AppFeatureServiceView): AppFeatureServiceMutators =>
    ({
      service: target,
      addEnv: () => {},
      addDependency: () => {},
      addBuildStep: (step: ServiceBuildStepIntent) => {
        steps.push(step);
      },
      addMount: unsupported("addMount"),
      setAppMount: unsupported("setAppMount"),
      addStorage: unsupported("addStorage"),
      addEndpoint: unsupported("addEndpoint"),
      addHostAlias: unsupported("addHostAlias"),
      setHealthcheck: unsupported("setHealthcheck"),
      setCerts: unsupported("setCerts"),
      setEntrypoint: unsupported("setEntrypoint"),
      setCommand: unsupported("setCommand"),
      setArtifact: unsupported("setArtifact"),
      setUser: unsupported("setUser"),
      setWorkingDirectory: unsupported("setWorkingDirectory"),
    }) as unknown as AppFeatureServiceMutators;

  const context: AppFeatureContext = {
    featureId: mailpitWireFeature.id,
    appName: "mail-demo",
    appRoot: "/srv/apps/mail-demo",
    config: {},
    selected: views,
    forEachSelected: (mutate) => {
      for (const target of views) mutate(mutatorsFor(target));
    },
    select: (name) => {
      const target = views.find((candidate) => candidate.serviceName === name);
      return target === undefined ? undefined : mutatorsFor(target);
    },
  };

  return Effect.runPromiseExit(mailpitWireFeature.apply(context)).then((result) => ({ result, steps }));
};

describe("Mailpit msmtp base family", () => {
  test("refuses an unprovable custom PHP image with a tagged base-family error", async () => {
    // Given
    const views = [
      view("mail", "mailpit", { type: "mailpit" }),
      view("web", "php:8.3", { type: "php:8.3", image: "my-registry.example/php:8.3" }, [PHP_FEATURE_ID]),
    ];
    // When
    const { result } = await applyWire(views);
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.cause._tag).toBe("Fail");
    if (result.cause._tag !== "Fail") return;
    const error = result.cause.error;
    expect(error).toBeInstanceOf(MailpitMsmtpBaseFamilyError);
    if (!(error instanceof MailpitMsmtpBaseFamilyError)) return;
    expect(error._tag).toBe("MailpitMsmtpBaseFamilyError");
    expect(error.feature).toBe("service-lando.mailpit.wire");
    expect(error.remediation).toContain("debian-bookworm");
    expect(error.remediation).toContain("debian-bullseye");
    expect(error.remediation).toContain("mailFrom");
  });

  test("wires a stock PHP service with the bookworm pin", async () => {
    // Given
    const views = [
      view("mail", "mailpit", { type: "mailpit" }),
      view("web", "php:8.3", { type: "php:8.3" }, [PHP_FEATURE_ID]),
    ];
    // When
    const { result, steps } = await applyWire(views);
    // Then
    expect(result._tag).toBe("Success");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.buildKeyInputs).toMatchObject({ msmtp: { family: "debian-bookworm" } });
  });
});
