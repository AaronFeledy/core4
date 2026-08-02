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
  "serviceLogSources",
  "sharedCrossAppNetwork",
  "persistentStorage",
  "bindMounts",
  "copyMounts",
  "copyOnWriteAppRoot",
  "artifactExport",
  "artifactImport",
  "ephemeralMounts",
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
  volumeSnapshot: ["native", "copy", "none"],
  serviceFileCopy: ["native", "exec", "none"],
} as const;

const ARRAY_FIELDS = ["providerExtensions"] as const;

const OPTIONAL_FIELDS = [
  "composeKnobs",
  "composePreservedPaths",
  "composeProjectFields",
  "composeServiceFields",
  "hostProxy",
] as const;

const COMPOSE_PRESERVED_PATH_KEYS = ["depends_on.*.restart", "healthcheck.start_interval"] as const;

const COMPOSE_PROJECT_FIELD_KEYS = ["configs", "secrets"] as const;

const COMPOSE_SERVICE_FIELD_KEYS = ["networks", "configs", "secrets", "profiles", "labels"] as const;

const COMPOSE_SERVICE_KNOB_KEYS = [
  "restart",
  "cap_add",
  "cap_drop",
  "privileged",
  "devices",
  "ulimits",
  "sysctls",
  "tmpfs",
  "shm_size",
  "dns",
  "dns_search",
  "dns_opt",
  "extra_hosts",
  "init",
  "stop_signal",
  "stop_grace_period",
  "security_opt",
  "group_add",
  "read_only",
  "platform",
  "pull_policy",
  "logging",
  "gpus",
  "deploy.resources",
] as const;

const REQUIRED_FIELD_SET = [...BOOLEAN_FIELDS, ...Object.keys(LITERAL_FIELDS), ...ARRAY_FIELDS].sort();
const EXPECTED_FIELD_SET = [...REQUIRED_FIELD_SET, ...OPTIONAL_FIELDS].sort();

const providerLandoFixture: typeof ProviderCapabilities.Encoded = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "exec",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
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
  serviceLogSources: true,
  serviceHealth: "native",
  hostReachability: "native",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "slow",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "exec",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native",
  routeProvider: false,
  tlsCertificates: "none",
  rootless: false,
  privilegedServices: true,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
};

describe("IsolateMode", () => {
  test("accepts the canonical scratch isolation modes", () => {
    for (const mode of ["full", "baked", "cwd"] as const) {
      expect(Either.isRight(Schema.decodeUnknownEither(IsolateMode)(mode))).toBe(true);
    }
  });

  test("rejects any other isolation value", () => {
    for (const invalid of ["", "none", "partial", "cow", "FULL"]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(IsolateMode)(invalid))).toBe(true);
    }
  });
});

describe("ProviderCapabilities — field set lock", () => {
  test("exposes exactly the documented capability fields (no additions, no omissions)", () => {
    const actual = Object.keys(ProviderCapabilities.fields).sort();
    expect(actual).toEqual(EXPECTED_FIELD_SET);
    expect(actual).toHaveLength(33);
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

  test("every literal capability accepts exactly the documented literal options", () => {
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

  test("hostProxy accepts structured container targets and a hostname-only TCP gateway", () => {
    const accepted = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      hostProxy: {
        containerTargets: [{ os: "linux", arch: "x64" }],
        tcpHostGateway: "host.containers.internal",
      },
    });
    expect(Either.isRight(accepted)).toBe(true);

    const rejectedTarget = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      hostProxy: { containerTargets: [{ os: "darwin", arch: "arm64" }] },
    });
    expect(Either.isLeft(rejectedTarget)).toBe(true);

    for (const tcpHostGateway of [
      "",
      "https://host.containers.internal",
      "host.containers.internal:80",
      "host/path",
    ]) {
      const rejectedGateway = Schema.decodeUnknownEither(ProviderCapabilities)({
        ...providerLandoFixture,
        hostProxy: { containerTargets: [], tcpHostGateway },
      });
      expect(Either.isLeft(rejectedGateway)).toBe(true);
    }
  });

  test("composeKnobs may be absent", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    expect(decoded.composeKnobs).toBeUndefined();
  });

  test("composeKnobs accepts an empty supported set", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composeKnobs: { supported: [] },
    });
    expect(decoded.composeKnobs?.supported).toEqual([]);
  });

  test("composeKnobs accepts every published knob key in contract order", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composeKnobs: { supported: COMPOSE_SERVICE_KNOB_KEYS },
    });
    expect(decoded.composeKnobs?.supported).toEqual(COMPOSE_SERVICE_KNOB_KEYS);
  });

  test("absent composeKnobs is semantically equivalent to an empty supported set", () => {
    const absent = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    const empty = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composeKnobs: { supported: [] },
    });

    expect(absent.composeKnobs?.supported ?? []).toEqual(empty.composeKnobs?.supported ?? []);
  });

  test("composeServiceFields may be absent", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    expect(decoded.composeServiceFields).toBeUndefined();
  });

  test("composeServiceFields accepts every published service field key in contract order", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composeServiceFields: { supported: COMPOSE_SERVICE_FIELD_KEYS },
    });
    expect(decoded.composeServiceFields?.supported).toEqual(COMPOSE_SERVICE_FIELD_KEYS);
  });

  test("rejects x-* as a composeServiceFields capability key", () => {
    const decoded = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      composeServiceFields: { supported: ["x-*"] },
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("composePreservedPaths may be absent", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    expect(decoded.composePreservedPaths).toBeUndefined();
  });

  test("composeProjectFields accepts every published project field in contract order", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composeProjectFields: { supported: COMPOSE_PROJECT_FIELD_KEYS },
    });
    expect(decoded.composeProjectFields?.supported).toEqual(COMPOSE_PROJECT_FIELD_KEYS);
  });

  test("composePreservedPaths accepts every published exact path in contract order", () => {
    const decoded = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composePreservedPaths: { supported: COMPOSE_PRESERVED_PATH_KEYS },
    });
    expect(decoded.composePreservedPaths?.supported).toEqual(COMPOSE_PRESERVED_PATH_KEYS);
  });

  test("absent composePreservedPaths is equivalent to an empty supported set", () => {
    const absent = Schema.decodeUnknownSync(ProviderCapabilities)(providerLandoFixture);
    const empty = Schema.decodeUnknownSync(ProviderCapabilities)({
      ...providerLandoFixture,
      composePreservedPaths: { supported: [] },
    });

    expect(absent.composePreservedPaths?.supported ?? []).toEqual(
      empty.composePreservedPaths?.supported ?? [],
    );
  });

  test("rejects an unpublished compose preserved path", () => {
    const decoded = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      composePreservedPaths: { supported: ["depends_on.*.condition"] },
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects x-* as a composePreservedPaths capability key", () => {
    const decoded = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      composePreservedPaths: { supported: ["x-*"] },
    });
    expect(Either.isLeft(decoded)).toBe(true);
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
    expect(decoded.volumeSnapshot).toBe("none");
    expect(decoded.serviceFileCopy).toBe("exec");
    expect(decoded.artifactExport).toBe(false);
    expect(decoded.artifactImport).toBe(false);
    expect(decoded.ephemeralMounts).toBe(false);
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
    expect(decoded.volumeSnapshot).toBe("none");
    expect(decoded.serviceFileCopy).toBe("exec");
    expect(decoded.artifactExport).toBe(false);
    expect(decoded.artifactImport).toBe(false);
    expect(decoded.ephemeralMounts).toBe(false);
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

  test("rejects an unknown compose knob key with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(ProviderCapabilities)({
      ...providerLandoFixture,
      composeKnobs: { supported: ["deploy"] },
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("composeKnobs"))).toBe(true);
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
    for (const field of REQUIRED_FIELD_SET) {
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
