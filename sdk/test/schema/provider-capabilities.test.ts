import { describe, expect, test } from "bun:test";

import { Either, ParseResult, Schema } from "effect";

import { IsolateMode, ProviderCapabilities } from "@lando/sdk/schema";

const BOOLEAN_FIELDS = [
  "artifactBuild",
  "artifactPull",
  "buildSecrets",
  "buildSsh",
  "multiServiceApply",
  "serviceExec",
  "serviceLogs",
  "sharedCrossAppNetwork",
  "persistentStorage",
  "bindMounts",
  "copyMounts",
  "copyOnWriteAppRoot",
  "routeProvider",
  "rootless",
  "privilegedServices",
] as const;

const LITERAL_FIELDS = {
  serviceHealth: ["native", "lando", "none"],
  hostReachability: ["native", "emulated", "none"],
  bindMountPerformance: ["native", "slow", "none"],
  hostPortPublish: ["native", "proxy", "manual", "none"],
  tlsCertificates: ["native", "lando", "none"],
  composeSpec: ["none", "portable", "native"],
} as const;

const ARRAY_FIELDS = ["providerExtensions"] as const;

const EXPECTED_FIELD_SET = [...BOOLEAN_FIELDS, ...Object.keys(LITERAL_FIELDS), ...ARRAY_FIELDS].sort();

const providerLandoFixture: typeof ProviderCapabilities.Encoded = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

const providerDockerFixture: typeof ProviderCapabilities.Encoded = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "slow",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  hostPortPublish: "native",
  routeProvider: false,
  tlsCertificates: "none",
  rootless: false,
  privilegedServices: true,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

describe("IsolateMode", () => {
  test("accepts the two scratch isolation modes", () => {
    for (const mode of ["none", "full"] as const) {
      expect(Either.isRight(Schema.decodeUnknownEither(IsolateMode)(mode))).toBe(true);
    }
  });

  test("rejects any other isolation value", () => {
    for (const invalid of ["", "partial", "cow", "FULL"]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(IsolateMode)(invalid))).toBe(true);
    }
  });
});

describe("ProviderCapabilities — field set lock", () => {
  test("exposes exactly the spec-mandated fields (no additions, no omissions)", () => {
    const actual = Object.keys(ProviderCapabilities.fields).sort();
    expect(actual).toEqual(EXPECTED_FIELD_SET);
    expect(actual).toHaveLength(22);
  });

  test("every boolean capability accepts only booleans", () => {
    for (const field of BOOLEAN_FIELDS) {
      for (const value of [true, false]) {
        const accepted = Schema.decodeUnknownEither(ProviderCapabilities)({
          ...providerLandoFixture,
          [field]: value,
        });
        expect(Either.isRight(accepted)).toBe(true);
      }

      const rejected = Schema.decodeUnknownEither(ProviderCapabilities)({
        ...providerLandoFixture,
        [field]: "true",
      });
      expect(Either.isLeft(rejected)).toBe(true);
    }
  });

  test("every literal capability accepts exactly the spec literal options", () => {
    const literalEntries = Object.entries(LITERAL_FIELDS) as Array<
      [keyof typeof LITERAL_FIELDS, readonly [string, ...string[]]]
    >;

    for (const [field, expected] of literalEntries) {
      const literalSchema = ProviderCapabilities.fields[field] as Schema.Literal<
        readonly [string, ...string[]]
      >;
      expect([...literalSchema.literals].sort()).toEqual([...expected].sort());

      for (const value of expected) {
        const accepted = Schema.decodeUnknownEither(ProviderCapabilities)({
          ...providerLandoFixture,
          [field]: value,
        });
        expect(Either.isRight(accepted)).toBe(true);
      }

      const rejected = Schema.decodeUnknownEither(ProviderCapabilities)({
        ...providerLandoFixture,
        [field]: "__not_a_spec_literal__",
      });
      expect(Either.isLeft(rejected)).toBe(true);
    }
  });

  test("providerExtensions accepts only arrays of strings", () => {
    const accepted = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      providerExtensions: ["compose", "labels"],
    });
    expect(Either.isRight(accepted)).toBe(true);

    const rejected = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      providerExtensions: ["compose", 1],
    });
    expect(Either.isLeft(rejected)).toBe(true);
  });
});

describe("ProviderCapabilities — provider-lando fixture (bindMountPerformance: native)", () => {
  test("decodes the Linux/native fixture into the typed shape", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    expect(decoded.bindMountPerformance).toBe("native");
    expect(decoded.serviceHealth).toBe("native");
    expect(decoded.hostReachability).toBe("native");
    expect(decoded.hostPortPublish).toBe("native");
    expect(decoded.tlsCertificates).toBe("lando");
    expect(decoded.composeSpec).toBe("native");
    expect(decoded.bindMounts).toBe(true);
    expect(decoded.rootless).toBe(true);
    expect(decoded.privilegedServices).toBe(false);
    expect(decoded.providerExtensions).toEqual(["compose", "labels", "registryCredentials"]);
  });
});

describe("ProviderCapabilities — provider-docker fixture (bindMountPerformance: slow)", () => {
  test("decodes the Docker Desktop/slow fixture into the typed shape", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)(providerDockerFixture);
    expect(decoded.bindMountPerformance).toBe("slow");
    expect(decoded.serviceHealth).toBe("native");
    expect(decoded.hostReachability).toBe("native");
    expect(decoded.tlsCertificates).toBe("none");
    expect(decoded.routeProvider).toBe(false);
    expect(decoded.rootless).toBe(false);
    expect(decoded.privilegedServices).toBe(true);
    expect(decoded.composeSpec).toBe("native");
  });
});

describe("ProviderCapabilities — rejection paths", () => {
  test("rejects an unknown bindMountPerformance literal with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      bindMountPerformance: "fast",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("bindMountPerformance"))).toBe(true);
    }
  });

  test("rejects an unknown composeSpec literal with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      composeSpec: "extended",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("composeSpec"))).toBe(true);
    }
  });

  test("rejects an unknown hostPortPublish literal with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      hostPortPublish: "auto",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("hostPortPublish"))).toBe(true);
    }
  });

  test("rejects a non-boolean artifactBuild with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      artifactBuild: "yes",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("artifactBuild"))).toBe(true);
    }
  });

  test("rejects a providerExtensions that is not an array of strings", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      providerExtensions: "compose",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("providerExtensions"))).toBe(true);
    }
  });

  test("treats every field as required — omitting any one fails decoding (defaults are not from caller code)", () => {
    for (const field of EXPECTED_FIELD_SET) {
      const { [field]: _omitted, ...partial } = providerLandoFixture as Record<string, unknown>;
      const result = Schema.decodeUnknownEither(ProviderCapabilities)(partial);
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(ParseResult.isParseError(result.left)).toBe(true);
        const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
        expect(issues.some((issue) => issue.path.includes(field))).toBe(true);
      }
    }
  });
});
