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
  ToolingTaskShape,
  ToolingVar,
  getJsonSchema,
} from "@lando/sdk/schema";

const ALPHA_TOOLING_FIELDS = ["service", "description", "summary", "cmd", "cmds", "vars"] as const;

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

describe("LandofileShape — Beta schema gate", () => {
  test("JSON Schema exposes every shipped Beta top-level Landofile key", () => {
    const schema = getJsonSchema("LandofileShape") as { readonly properties?: Record<string, unknown> };
    const properties = schema.properties ?? {};

    for (const key of ["includes", "template", "secrets", "services", "tooling"] as const) {
      expect(properties).toHaveProperty(key);
    }
  });

  test("strict decoding accepts template selection and top-level Compose secrets", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      {
        name: "myapp",
        template: "handlebars",
        secrets: {
          db_password: { file: "./.secrets/db-password" },
          api_token: { environment: "LANDO_SECRET_API_TOKEN" },
        },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isRight(result)).toBe(true);
  });
});

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
    expect(decoded.telemetry.enabled).toBe(false);
  });

  test("defaultProviderId accepts an explicit null (opt-out signal)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: null });
    expect(decoded.defaultProviderId).toBeNull();
  });
});

describe("ServiceConfig — ports numeric coercion (bugbot PR#28 finding 2)", () => {
  test('decodes ports: [8080] (bare integer) as ["8080"]', () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: [8080] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual(["8080"]);
  });

  test('decodes ports: ["8080:80"] (string mapping) unchanged', () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: ["8080:80"] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual(["8080:80"]);
  });

  test('decodes ports: [8080, "9000:90"] (mixed numeric + string) as ["8080", "9000:90"]', () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: [8080, "9000:90"] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual(["8080", "9000:90"]);
  });
});

describe("LandofileShape — tooling: Alpha schema", () => {
  test("decodes tooling tasks with cmd, cmds, service, description, and summary", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      tooling: {
        composer: { service: "appserver", description: "Run Composer", cmd: "composer" },
        test: {
          service: "appserver",
          summary: "Run the test suite",
          cmds: ["composer install", "phpunit"],
        },
      },
    });
    expect(decoded.tooling?.composer?.service).toBe("appserver");
    expect(decoded.tooling?.composer?.description).toBe("Run Composer");
    expect(decoded.tooling?.composer?.cmd).toBe("composer");
    expect(decoded.tooling?.test?.summary).toBe("Run the test suite");
    expect(decoded.tooling?.test?.cmds).toEqual(["composer install", "phpunit"]);
  });

  test("decodes Alpha `vars:` forms: literal, default, sh, and prompt", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      tooling: {
        build: {
          cmd: "make",
          vars: {
            MODE: "dev",
            COUNT: 3,
            DEBUG: true,
            ENV: { default: "development" },
            SHA: { sh: "git rev-parse HEAD" },
            TAG: { prompt: "Enter the release tag" },
          },
        },
      },
    });
    const vars = decoded.tooling?.build?.vars ?? {};
    expect(vars.MODE).toBe("dev");
    expect(vars.COUNT).toBe(3);
    expect(vars.DEBUG).toBe(true);
    expect(vars.ENV).toEqual({ default: "development" });
    expect(vars.SHA).toEqual({ sh: "git rev-parse HEAD" });
    expect(vars.TAG).toEqual({ prompt: "Enter the release tag" });
  });

  test("strict decoding rejects Beta-only task fields (`deps`)", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { tooling: { test: { cmds: ["pytest"], deps: ["assets"] } } },
      { onExcessProperty: "error" },
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  test("strict decoding rejects unsafe `raw:` var form", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { tooling: { run: { cmd: "echo", vars: { X: { raw: "$(date)" } } } } },
      { onExcessProperty: "error" },
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  test("strict decoding rejects step-object cmd entries (`task:`)", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { tooling: { build: { cmds: [{ task: "assets" }] } } },
      { onExcessProperty: "error" },
    );
    expect(Either.isLeft(result)).toBe(true);
  });

  test("ToolingTaskShape exposes every Alpha-supported field as optional", () => {
    const fields = Object.keys(ToolingTaskShape.fields);
    for (const key of ALPHA_TOOLING_FIELDS) {
      expect(fields).toContain(key);
    }
  });

  test("ToolingVar decodes literal, default, sh, and prompt forms", () => {
    expect(Schema.decodeUnknownSync(ToolingVar)("dev")).toBe("dev");
    expect(Schema.decodeUnknownSync(ToolingVar)({ default: "latest" })).toEqual({ default: "latest" });
    expect(Schema.decodeUnknownSync(ToolingVar)({ sh: "git rev-parse HEAD" })).toEqual({
      sh: "git rev-parse HEAD",
    });
    expect(Schema.decodeUnknownSync(ToolingVar)({ prompt: "Tag?" })).toEqual({ prompt: "Tag?" });
  });
});
