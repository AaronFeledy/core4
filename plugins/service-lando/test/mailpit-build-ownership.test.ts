import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { AppFeatureMutationConflictError, MailpitMsmtpBaseFamilyError } from "@lando/sdk/errors";
import { ServiceConfig } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
} from "@lando/sdk/services";
import { mailpitWireFeature } from "../src/app-features/mailpit.ts";
import { PHP_RUNTIME_POLICY_KEY } from "../src/services/php-runtime-policy.ts";
import { PHP_FEATURE_ID } from "../src/services/php.ts";
import { phpResolution } from "./support/php-resolution.ts";

const view = (serviceName: string, input: Readonly<Record<string, unknown>>): AppFeatureServiceView => {
  const normalizedConfig = Schema.decodeUnknownSync(ServiceConfig)(input);
  const serviceType = normalizedConfig.type ?? "php:8.3";
  return {
    serviceName,
    serviceType,
    normalizedConfig,
    base: "lando",
    primary: false,
    featureIds: serviceType.startsWith("php:") ? [PHP_FEATURE_ID] : [],
    resolutionMetadata: serviceType.startsWith("php:") ? phpResolution(normalizedConfig).metadata : undefined,
  };
};

const applyWire = async (selected: ReadonlyArray<AppFeatureServiceView>) => {
  const mutations: string[] = [];
  const mutatorsFor = (service: AppFeatureServiceView): AppFeatureServiceMutators => {
    const record = () => {
      mutations.push(service.serviceName);
    };
    return {
      service,
      addEnv: record,
      addDependency: record,
      addBuildStep: record,
      addMount: record,
      setAppMount: record,
      addStorage: record,
      addHostAlias: record,
      setHealthcheck: record,
      setReadiness: record,
      setCerts: record,
      setEntrypoint: record,
      setCommand: record,
      setInit: record,
      setArtifact: record,
      setUser: record,
      setWorkingDirectory: record,
    };
  };
  const context: AppFeatureContext = {
    featureId: mailpitWireFeature.id,
    appName: "php-ownership",
    appRoot: "/srv/apps/php-ownership",
    config: {},
    selected,
    forEachSelected: (mutate) => {
      for (const service of selected) mutate(mutatorsFor(service));
    },
    select: (name) => {
      const service = selected.find((candidate) => candidate.serviceName === name);
      return service === undefined ? undefined : mutatorsFor(service);
    },
  };
  const result = await Effect.runPromiseExit(mailpitWireFeature.apply(context));
  return { result, mutations };
};

describe("Mailpit replacement-build ownership", () => {
  test("validates a reused sender policy once across multiple inboxes", async () => {
    // Given
    const sender = view("web", { type: "php:8.3" });
    let reads = 0;
    const selected = [
      view("first", { type: "mailpit" }),
      view("second", { type: "mailpit" }),
      {
        ...sender,
        get resolutionMetadata() {
          reads++;
          return sender.resolutionMetadata;
        },
      },
    ];
    // When
    const { result, mutations } = await applyWire(selected);
    // Then
    expect(Exit.isSuccess(result)).toBe(true);
    expect(reads).toBe(1);
    expect(mutations).toHaveLength(8);
  });
  test.each([undefined, {}, { [PHP_RUNTIME_POLICY_KEY]: { artifactSource: "private-secret-payload" } }])(
    "refuses missing/malformed selected policy before wiring %j",
    async (resolutionMetadata) => {
      // Given
      const selected = [
        view("mail", { type: "mailpit" }),
        view("stock", { type: "php:8.3" }),
        { ...view("web", { type: "php:8.3" }), resolutionMetadata },
      ];
      // When
      const { result, mutations } = await applyWire(selected);
      // Then
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
        expect(error).toBeInstanceOf(AppFeatureMutationConflictError);
        expect(error).toMatchObject({ service: "web", field: "resolutionMetadata" });
        expect(JSON.stringify(error)).not.toContain("private-secret-payload");
        expect(error).not.toHaveProperty("cause");
        expect(error).not.toHaveProperty("existing");
        expect(error).not.toHaveProperty("incoming");
      }
      expect(mutations).toEqual([]);
    },
  );

  test("uses resolved family evidence rather than normalized image/build fields", async () => {
    // Given
    const sender = view("web", { type: "php:8.3", image: "php:8.2-cli-bullseye" });
    const selected = [
      view("mail", { type: "mailpit" }),
      {
        ...sender,
        normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({
          type: "php:8.3",
          build: { context: "." },
          image: "unproven:latest",
        }),
      },
    ];
    // When
    const { result, mutations } = await applyWire(selected);
    // Then
    expect(Exit.isSuccess(result)).toBe(true);
    expect(mutations).toEqual(["web", "web", "web", "web"]);
  });

  test("unproven references get image-specific diagnostics without replacement-build advice", async () => {
    // Given
    const selected = [
      view("mail", { type: "mailpit" }),
      view("web", { type: "php:8.3", image: "acme/php:8" }),
    ];
    // When
    const { result, mutations } = await applyWire(selected);
    // Then
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
      expect(error).toMatchObject({
        _tag: "MailpitMsmtpBaseFamilyError",
        service: "web",
        image: "acme/php:8",
        reason: "unproven-image-family",
      });
      if (!(error instanceof MailpitMsmtpBaseFamilyError)) throw new Error("missing family error");
      expect(error.remediation).toContain("php:<version>");
      expect(error.remediation).toContain("mailFrom");
      expect(error.remediation).not.toMatch(/build|Dockerfile/u);
    }
    expect(mutations).toEqual([]);
  });
  for (const image of [undefined, "php:8.3-apache-bookworm", "php:8.3-cli-bullseye"]) {
    test.each([{ mailFrom: undefined }, { mailFrom: ["stock", "web"] }])(
      `rejects a selected contextual sender before any mutation (image=${image}, mailFrom=%j)`,
      async ({ mailFrom }) => {
        // Given: an earlier inbox and stock sender could otherwise be mutated before the failure.
        const selected = [
          view("first", { type: "mailpit", mailFrom: ["stock"] }),
          view("mail", { type: "mailpit", ...(mailFrom === undefined ? {} : { mailFrom }) }),
          view("stock", { type: "php:8.3" }),
          view("web", {
            type: "php:8.3",
            build: { context: "." },
            ...(image === undefined ? {} : { image }),
          }),
        ];
        // When
        const { result, mutations } = await applyWire(selected);
        // Then: selection fails with the existing tagged error before touching either sender.
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(MailpitMsmtpBaseFamilyError);
          expect(error).toMatchObject({
            _tag: "MailpitMsmtpBaseFamilyError",
            feature: mailpitWireFeature.id,
            service: "web",
            reason: "replacement-build",
          });
        }
        expect(mutations).toEqual([]);
      },
    );
  }

  test.each([{ mailFrom: false }, { mailFrom: ["stock"] }])(
    "accepts an excluded contextual sender with mailFrom=%j",
    async ({ mailFrom }) => {
      // Given
      const selected = [
        view("mail", { type: "mailpit", mailFrom }),
        view("stock", { type: "php:8.3" }),
        view("web", { type: "php:8.3", build: { context: "." }, image: "php:8.3-apache-bookworm" }),
      ];
      // When
      const { result, mutations } = await applyWire(selected);
      // Then: only an explicitly included stock sender receives the four wiring mutations.
      expect(Exit.isSuccess(result)).toBe(true);
      expect(mutations).toEqual(mailFrom === false ? [] : ["stock", "stock", "stock", "stock"]);
    },
  );
});
