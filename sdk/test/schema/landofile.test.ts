import { describe, expect, test } from "bun:test";

import { Either, ParseResult, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  GlobalConfig,
  LandofileShape,
  ProviderId,
  ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";

const MVP_COMPOSE_SUBSET = ["image", "ports", "environment", "volumes", "command", "dependsOn"] as const;

const minimalLandofileFixture: typeof LandofileShape.Encoded = {
  name: "myapp",
  services: {
    web: {
      image: "node:20",
      ports: ["3000:3000"],
      environment: { NODE_ENV: "development" },
      volumes: ["./src:/app"],
      command: "npm start",
      dependsOn: ["db"],
    },
  },
};

describe("LandofileShape (MVP)", () => {
  test("decodes a minimal Landofile with one app name + one service block + Compose-subset keys", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)(minimalLandofileFixture);
    expect(decoded.name).toBe("myapp");
    const web = decoded.services?.[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect(web.image).toBe("node:20");
    expect(web.ports).toEqual(["3000:3000"]);
    expect(web.environment).toEqual({ NODE_ENV: "development" });
    expect(web.volumes).toEqual(["./src:/app"]);
    expect(web.command).toBe("npm start");
    expect(web.dependsOn).toEqual(["db"]);
  });

  test("ServiceConfig exposes every MVP Compose-subset key as an optional field", () => {
    const fields = Object.keys(ServiceConfig.fields);
    for (const key of MVP_COMPOSE_SUBSET) {
      expect(fields).toContain(key);
    }
  });

  test("strict decoding rejects Compose keys outside the MVP allowlist (e.g. `deploy`)", () => {
    const withDisallowedKey = {
      name: "myapp",
      services: {
        web: {
          image: "node:20",
          deploy: { replicas: 3 },
        },
      },
    };

    const result = Schema.decodeUnknownEither(LandofileShape)(withDisallowedKey, {
      onExcessProperty: "error",
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      const rejectionRow = issues.find((row) => row.path.includes("deploy"));
      expect(rejectionRow).toBeDefined();
      expect(rejectionRow?._tag).toBe("Unexpected");
    }
  });

  test("a strict-decode failure converts into a LandofileValidationError that names the rejected key", () => {
    const withDisallowedKey = {
      name: "myapp",
      services: {
        web: {
          image: "node:20",
          deploy: { replicas: 3 },
        },
      },
    };

    const result = Schema.decodeUnknownEither(LandofileShape)(withDisallowedKey, {
      onExcessProperty: "error",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) return;

    const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
    const rejectedKeys = issues.filter((row) => row._tag === "Unexpected").map((row) => row.path.join("."));
    expect(rejectedKeys.length).toBeGreaterThan(0);

    const err = new LandofileValidationError({
      message: `Landofile rejected ${rejectedKeys.length} unknown key(s): ${rejectedKeys.join(", ")}`,
      file: "/srv/apps/myapp/.lando.yml",
      issues: rejectedKeys,
    });
    expect(err._tag).toBe("LandofileValidationError");
    expect(err.message).toContain("deploy");
    expect(err.issues).toContain("services.web.deploy");
  });

  test("non-strict decoding strips unknown keys by default", () => {
    const withDisallowedKey = {
      name: "myapp",
      services: {
        web: {
          image: "node:20",
          deploy: { replicas: 3 },
        },
      },
    };

    const decoded = Schema.decodeUnknownSync(LandofileShape)(withDisallowedKey);
    const web = decoded.services?.[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect((web as Record<string, unknown>).deploy).toBeUndefined();
  });
});

describe("GlobalConfig (MVP)", () => {
  test("covers the PRD-mandated MVP fields (userDataRoot, userConfRoot, defaultProviderId, telemetry.enabled)", () => {
    const fields = Object.keys(GlobalConfig.fields);
    expect(fields).toContain("userDataRoot");
    expect(fields).toContain("userConfRoot");
    expect(fields).toContain("defaultProviderId");
    expect(fields).toContain("telemetry");
  });

  test("decodes a minimal global config with the four MVP fields", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      userDataRoot: "/srv/lando/data",
      userConfRoot: "/srv/lando/conf",
      defaultProviderId: "lando",
      telemetry: { enabled: false },
    });
    expect(decoded.userDataRoot).toBe(AbsolutePath.make("/srv/lando/data"));
    expect(decoded.userConfRoot).toBe(AbsolutePath.make("/srv/lando/conf"));
    expect(decoded.defaultProviderId).toBe(ProviderId.make("lando"));
    expect(decoded.telemetry?.enabled).toBe(false);
  });

  test("telemetry.enabled defaults to false when omitted from the input", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      telemetry: {},
    });
    expect(decoded.telemetry?.enabled).toBe(false);
  });

  test("decodes an empty object (every field is optional at MVP)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({});
    expect(decoded).toBeDefined();
  });

  test("defaultProviderId accepts an explicit null (opt-out signal)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: null });
    expect(decoded.defaultProviderId).toBeNull();
  });
});
