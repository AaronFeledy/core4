import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  LandofileShape,
  PortablePath,
  ServiceConfig,
  ServiceConfigInput,
  ServiceDependency,
  ServiceName,
  getJsonSchema,
} from "../../src/schema/index.ts";

// The user-facing Landofile boundary decodes through LandofileShape.services
// (which wraps ServiceConfigInput -> ServiceConfig). ServiceConfig itself
// canonicalizes the per-key alternate forms for direct decoders.

const decodeService = (raw: unknown): ServiceConfig => Schema.decodeUnknownSync(ServiceConfig)(raw);

const decodeAuthored = (service: Record<string, unknown>): ServiceConfig => {
  const shape = Schema.decodeUnknownSync(LandofileShape)(
    { name: "app", services: { web: service } },
    { onExcessProperty: "error" },
  );
  const web = shape.services?.[ServiceName.make("web")];
  if (web === undefined) throw new Error("missing web service");
  return web;
};

const reservedKeyRecord = (value: unknown): Record<string, unknown> =>
  Object.fromEntries([["__proto__", value]]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const propertyNameAllows = (constraint: unknown, key: string): boolean => {
  if (!isRecord(constraint)) return false;
  const { anyOf: alternatives, enum: values, pattern } = constraint;
  if (Array.isArray(alternatives)) return alternatives.some((entry) => propertyNameAllows(entry, key));
  if (Array.isArray(values) && !values.includes(key)) return false;
  return typeof pattern !== "string" || new RegExp(pattern, "u").test(key);
};

const expectReservedKeyRejection = (result: Either.Either<unknown, unknown>): void => {
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(String(result.left)).toContain("__proto__");
};

describe("ServiceConfig compose spellings and alternate forms", () => {
  describe("environment", () => {
    test("KEY=value list form canonicalizes to a map", () => {
      expect(decodeService({ environment: ["NODE_ENV=development", "PORT=3000"] }).environment).toEqual({
        NODE_ENV: "development",
        PORT: "3000",
      });
    });

    test("map form is preserved", () => {
      expect(decodeService({ environment: { NODE_ENV: "development" } }).environment).toEqual({
        NODE_ENV: "development",
      });
    });

    test("bare list entry without '=' fails with KEY=value remediation", () => {
      const result = Schema.decodeUnknownEither(ServiceConfig)({ environment: ["NODE_ENV"] });
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(String(result.left)).toContain("KEY=value");
      }
    });

    test("null map value fails with host-environment remediation", () => {
      const result = Schema.decodeUnknownEither(ServiceConfig)({ environment: { NODE_ENV: null } });
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(String(result.left)).toContain("host-environment interpolation is unsupported");
      }
    });

    test.each([
      ["map", reservedKeyRecord("polluted")],
      ["list", ["__proto__=polluted"]],
    ])("reserved __proto__ key in %s form is rejected", (_form, environment) => {
      expectReservedKeyRejection(Schema.decodeUnknownEither(ServiceConfig)({ environment }));
    });
  });

  describe("labels", () => {
    test("map form canonicalizes", () => {
      expect(decodeService({ labels: { "com.example.tier": "web" } }).labels).toEqual({
        "com.example.tier": "web",
      });
    });

    test("KEY=value list form canonicalizes; bare entry becomes empty string", () => {
      expect(decodeService({ labels: ["com.example.tier=web", "bare"] }).labels).toEqual({
        "com.example.tier": "web",
        bare: "",
      });
    });

    test("null map value canonicalizes to an empty string", () => {
      expect(decodeService({ labels: { "com.example.empty": null } }).labels).toEqual({
        "com.example.empty": "",
      });
    });

    test.each([
      ["map", reservedKeyRecord("polluted")],
      ["list", ["__proto__=polluted"]],
    ])("reserved __proto__ key in %s form is rejected", (_form, labels) => {
      expectReservedKeyRejection(Schema.decodeUnknownEither(ServiceConfig)({ labels }));
    });
  });

  describe("dependsOn", () => {
    test("string list canonicalizes to structured entries", () => {
      expect(decodeService({ dependsOn: ["database", "cache"] }).dependsOn).toEqual([
        { service: "database" },
        { service: "cache" },
      ]);
    });

    test("condition-map form canonicalizes, preserving condition/required/restart", () => {
      expect(
        decodeService({
          dependsOn: {
            database: { condition: "service_healthy", required: false, restart: true },
          },
        }).dependsOn,
      ).toEqual([{ service: "database", condition: "service_healthy", required: false, restart: true }]);
    });

    test.each(["service_started", "service_healthy", "service_completed_successfully"] as const)(
      "condition-map accepts %s",
      (condition) => {
        expect(decodeService({ dependsOn: { database: { condition } } }).dependsOn).toEqual([
          { service: "database", condition },
        ]);
      },
    );

    test("condition-map rejects an entry without condition", () => {
      expect(Either.isLeft(Schema.decodeUnknownEither(ServiceConfig)({ dependsOn: { database: {} } }))).toBe(
        true,
      );
    });

    test("encoding a non-bare dependency defaults its condition", () => {
      expect(
        Schema.encodeSync(ServiceConfig)({ dependsOn: [{ service: "database", required: false }] }),
      ).toEqual({
        dependsOn: { database: { condition: "service_started", required: false } },
      });
    });

    test("reserved __proto__ map key is rejected on decode", () => {
      expectReservedKeyRejection(
        Schema.decodeUnknownEither(ServiceConfig)({
          dependsOn: reservedKeyRecord({ condition: "service_started" }),
        }),
      );
    });

    test("reserved __proto__ service is rejected on dependency-map encode", () => {
      const result = Schema.encodeEither(ServiceConfig)({
        dependsOn: [{ service: "__proto__", condition: "service_healthy" }],
      });
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(String(result.left)).toContain("__proto__");
    });
  });

  describe("envFile", () => {
    test("string form canonicalizes to a list", () => {
      expect(decodeService({ envFile: "./.env" }).envFile).toEqual(["./.env"]);
    });

    test("list form is preserved", () => {
      expect(decodeService({ envFile: ["./.env", "./.env.local"] }).envFile).toEqual([
        "./.env",
        "./.env.local",
      ]);
    });
  });

  test("preserves canonical ports and volumes with default decode options", () => {
    // Given
    const input: ServiceConfig = {
      ports: [{ target: 80, hostIp: "127.0.0.1", protocol: "tcp", appProtocol: "http" }],
      volumes: [
        { type: "volume", source: "data", target: "/var/lib/data", readOnly: true, subpath: "app" },
        { type: "bind", source: "./src", target: "/app", readOnly: true, createHostPath: false },
      ],
    };

    // When
    const decoded = decodeService(input);

    // Then
    expect(decoded).toEqual(input);
  });

  describe("Compose cross-key spellings via Landofile boundary (Lando key wins)", () => {
    test("expose is accepted through the ServiceConfigInput and ServiceConfigDecode authoring boundary", () => {
      expect(decodeAuthored({ expose: ["3000-3001", 9229] }).expose).toEqual([3000, 3001, 9229]);
    });

    test("working_dir decodes to workingDirectory", () => {
      expect(decodeAuthored({ working_dir: "/app" }).workingDirectory).toBe(PortablePath.make("/app"));
    });

    test("workingDirectory wins over working_dir when both present", () => {
      expect(decodeAuthored({ working_dir: "/compose", workingDirectory: "/lando" }).workingDirectory).toBe(
        PortablePath.make("/lando"),
      );
    });

    test("depends_on string-list decodes to structured dependsOn", () => {
      expect(decodeAuthored({ depends_on: ["database"] }).dependsOn).toEqual([{ service: "database" }]);
    });

    test("depends_on condition-map decodes and preserves condition", () => {
      expect(
        decodeAuthored({ depends_on: { database: { condition: "service_completed_successfully" } } })
          .dependsOn,
      ).toEqual([{ service: "database", condition: "service_completed_successfully" }]);
    });

    test("dependsOn wins over depends_on when both present", () => {
      expect(decodeAuthored({ depends_on: ["compose"], dependsOn: ["lando"] }).dependsOn).toEqual([
        { service: "lando" },
      ]);
    });

    test("env_file decodes to envFile", () => {
      expect(decodeAuthored({ env_file: ["./.env"] }).envFile).toEqual(["./.env"]);
    });
  });

  describe("rejected sub-forms", () => {
    test("env_file long-object form is rejected", () => {
      const result = Schema.decodeUnknownEither(ServiceConfigInput)(
        { env_file: { path: "./.env", required: false } },
        { onExcessProperty: "error" },
      );
      expect(Either.isLeft(result)).toBe(true);
    });

    test("depends_on entry extension (x-*) is rejected", () => {
      const result = Schema.decodeUnknownEither(ServiceConfigInput)(
        { depends_on: { database: { condition: "service_healthy", "x-lando": true } } },
        { onExcessProperty: "error" },
      );
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("ServiceDependency schema is exported and canonical", () => {
    test("decodes a full entry", () => {
      expect(
        Schema.decodeUnknownSync(ServiceDependency)({
          service: "db",
          condition: "service_healthy",
          required: true,
          restart: false,
        }),
      ).toEqual({ service: "db", condition: "service_healthy", required: true, restart: false });
    });
  });

  describe("ServiceConfigInput public schema", () => {
    test("build property-name constraints allow declared keys and x-* extensions", () => {
      const schema = getJsonSchema("ServiceConfigInput");
      const definitions = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : {};
      const serviceConfigInput = definitions.ServiceConfigInput;
      const properties =
        isRecord(schema) && isRecord(schema.properties)
          ? schema.properties
          : isRecord(serviceConfigInput) && isRecord(serviceConfigInput.properties)
            ? serviceConfigInput.properties
            : {};
      const build = properties.build;
      const branches = isRecord(build) && Array.isArray(build.anyOf) ? build.anyOf : [];
      const objectBranch = branches.find(
        (branch): branch is Readonly<Record<string, unknown>> => isRecord(branch) && branch.type === "object",
      );
      const declaredProperties =
        objectBranch !== undefined && isRecord(objectBranch.properties)
          ? Object.keys(objectBranch.properties)
          : [];

      expect(declaredProperties.length).toBeGreaterThan(0);
      for (const key of declaredProperties) {
        expect(propertyNameAllows(objectBranch?.propertyNames, key)).toBe(true);
      }
      expect(propertyNameAllows(objectBranch?.propertyNames, "x-review")).toBe(true);
      expect(propertyNameAllows(objectBranch?.propertyNames, "not-a-build-key")).toBe(false);
    });

    test("contains canonical keys and Compose aliases", () => {
      const schema = getJsonSchema("ServiceConfigInput") as {
        readonly $defs?: Readonly<
          Record<string, { readonly properties?: Readonly<Record<string, unknown>> }>
        >;
        readonly properties?: Readonly<Record<string, unknown>>;
      };
      const properties = schema.properties ?? schema.$defs?.ServiceConfigInput?.properties ?? {};

      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining([
          "workingDirectory",
          "envFile",
          "dependsOn",
          "working_dir",
          "env_file",
          "depends_on",
        ]),
      );
    });

    test("preserves endpoint integer, range, and IP constraints", () => {
      const schema = JSON.stringify(getJsonSchema("ServiceConfigInput"));

      expect(schema).toContain('"type":"integer"');
      expect(schema).toContain('"minimum":1');
      expect(schema).toContain('"maximum":65535');
      expect(schema).toContain('"format":"ip"');
    });
  });
});
