import { describe, expect, test } from "bun:test";

import { Either, ParseResult, Schema } from "effect";
import * as AST from "effect/SchemaAST";

import { LandofileValidationError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  DatasetBinding,
  GlobalConfig,
  IncludeEntry,
  LandofileShape,
  PortablePath,
  ProviderId,
  RemoteConfig,
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

describe("LandofileShape — schema gate", () => {
  test("LandofileShape strictly decodes and round-trips per-app command aliases", () => {
    // Given
    const input = {
      name: "myapp",
      commandAliases: {
        enabled: true,
        disabled: ["stop", "scratch:gc"],
        custom: { hi: "app:greet", start: "app:wrapped-start" },
      },
    };

    // When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(input, { onExcessProperty: "error" });
    const encoded = Schema.encodeUnknownSync(LandofileShape)(decoded);

    // Then
    expect(encoded.commandAliases).toEqual(input.commandAliases);
  });

  test("LandofileShape rejects unknown command alias policy keys", () => {
    // Given
    const input = {
      name: "myapp",
      commandAliases: { enabled: true, unknown: "nope" },
    };

    // When
    const result = Schema.decodeUnknownEither(LandofileShape)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  test('IncludeEntry decodes kind: "compose"', () => {
    // Given
    const input = { source: "./f.yml", kind: "compose" };

    // When
    const result = Schema.decodeUnknownEither(IncludeEntry)(input);

    // Then
    expect(Either.isRight(result)).toBe(true);
  });

  test('IncludeEntry still decodes kind: "landofile"', () => {
    // Given
    const input = { source: "./f.yml", kind: "landofile" };

    // When
    const result = Schema.decodeUnknownEither(IncludeEntry)(input);

    // Then
    expect(Either.isRight(result)).toBe(true);
  });

  test('IncludeEntry decodes kind: "tooling" with its namespacing contract', () => {
    // Given
    const input = {
      source: "./docs/.lando.tasks.yml",
      kind: "tooling",
      namespace: "docs",
      flatten: false,
      internal: false,
      optional: true,
      aliases: ["documentation"],
      excludes: ["publish"],
      vars: { DOCS_PORT: 4321 },
    };

    // When
    const result = Schema.decodeUnknownEither(IncludeEntry)(input);

    // Then
    expect(Either.isRight(result)).toBe(true);
  });

  test("LandofileShape decodes the toolingIncludes shorthand", () => {
    // Given
    const input = {
      name: "myapp",
      toolingIncludes: {
        docs: {
          file: "./docs/.lando.tasks.yml",
          optional: true,
          flatten: false,
          internal: false,
          aliases: ["documentation"],
          excludes: ["publish"],
          vars: { DOCS_PORT: 4321 },
        },
      },
    };

    // When
    const result = Schema.decodeUnknownEither(LandofileShape)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isRight(result)).toBe(true);
  });

  test.each([
    ["scalar", "shared.env", ["shared.env"]],
    ["list", ["base.env", "local.env"], ["base.env", "local.env"]],
  ] as const)("LandofileShape decodes top-level env_file from %s input", (_form, envFile, expected) => {
    // Given
    const input = { name: "myapp", env_file: envFile };

    // When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(input, { onExcessProperty: "error" });

    // Then
    expect(decoded.env_file).toEqual(expected);
  });

  test("LandofileShape accepts its canonical top-level env_file output on merged-layer decode", () => {
    // Given
    const decoded = Schema.decodeUnknownSync(LandofileShape)({ name: "myapp", env_file: "shared.env" });

    // When
    const decodedAgain = Schema.decodeUnknownSync(LandofileShape)(decoded, {
      onExcessProperty: "error",
    });

    // Then
    expect(decodedAgain.env_file).toEqual(["shared.env"]);
    expect(Schema.encodeUnknownSync(LandofileShape)(decodedAgain).env_file).toEqual(["shared.env"]);
  });

  test("IncludeEntry still decodes the bare string form", () => {
    // Given
    const input = "./f.yml";

    // When
    const result = Schema.decodeUnknownEither(IncludeEntry)(input);

    // Then
    expect(Either.isRight(result)).toBe(true);
  });

  test("IncludeEntry kind carries a property-level description", () => {
    // Given
    const struct = AST.isUnion(IncludeEntry.ast)
      ? IncludeEntry.ast.types.find((member) => AST.isTypeLiteral(member))
      : undefined;
    const kind = struct?.propertySignatures.find(({ name }) => name === "kind");

    // When
    const description = kind?.annotations[AST.DescriptionAnnotationId];

    // Then
    expect(typeof description).toBe("string");
    expect(typeof description === "string" ? description.trim().length : 0).toBeGreaterThan(0);
  });

  test("JSON Schema exposes every shipped top-level Landofile key", () => {
    const schema = getJsonSchema("LandofileShape") as { readonly properties?: Record<string, unknown> };
    const properties = schema.properties ?? {};

    for (const key of [
      "configs",
      "env_file",
      "include",
      "includes",
      "networks",
      "remotes",
      "secrets",
      "services",
      "sshAgent",
      "sync",
      "tooling",
      "version",
      "volumes",
    ] as const) {
      expect(properties).toHaveProperty(key);
    }
    expect(JSON.stringify(schema)).toContain('"^x-"');
    expect(schema).toHaveProperty("additionalProperties", false);
    expect(properties).not.toHaveProperty("template");
  });

  test("strict decoding accepts the frozen top-level Compose subset", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      {
        name: "myapp",
        version: "3.9",
        services: { web: { image: "node:20" } },
        volumes: { data: { name: "myapp-data" } },
        networks: { frontend: { name: "myapp-frontend" } },
        configs: { app_config: { file: "./config.json" } },
        env_file: ["./shared.env"],
        secrets: {
          db_password: { file: "./.secrets/db-password" },
          api_token: { environment: "LANDO_SECRET_API_TOKEN" },
        },
        include: ["./compose.yml"],
        "x-team": { owner: "platform" },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isRight(result)).toBe(true);
  });

  test("strict decoding rejects non-directive top-level template keys", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      {
        name: "myapp",
        template: "handlebars",
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      const rejectionRow = issues.find((row) => row.path.includes("template"));
      expect(rejectionRow).toBeDefined();
      expect(rejectionRow?._tag).toBe("Unexpected");
    }
  });

  test("strict decoding preserves the SSH-agent sidecar default and true opt-in", () => {
    const omitted = Schema.decodeUnknownEither(LandofileShape)(
      { name: "myapp" },
      { onExcessProperty: "error" },
    );
    const explicit = Schema.decodeUnknownEither(LandofileShape)(
      { name: "myapp", sshAgent: { sidecar: true } },
      { onExcessProperty: "error" },
    );

    expect(Either.isRight(omitted)).toBe(true);
    expect(Either.isRight(explicit)).toBe(true);
  });

  test("strict decoding rejects reserved direct SSH-agent socket mounts", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { name: "myapp", sshAgent: { sidecar: false } },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((row) => row.path.join(".") === "sshAgent.sidecar")).toBe(true);
    }
  });

  test("strict decoding accepts raw remotes and dataset sync bindings", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)(
      {
        name: "myapp",
        remotes: {
          pantheon: {
            source: "pantheon",
            site: "site-id",
            token: "secret:pantheon-token",
          },
        },
        sync: {
          database: { service: "db" },
          files: { service: "appserver", path: "/app/web/sites/default/files" },
        },
      },
      { onExcessProperty: "error" },
    );

    expect(decoded.remotes?.pantheon).toEqual({
      source: "pantheon",
      site: "site-id",
      token: "secret:pantheon-token",
    });
    expect(decoded.sync?.database?.service === "db").toBe(true);
    expect(decoded.sync?.files?.service === "appserver").toBe(true);
    expect(decoded.sync?.files?.path === "/app/web/sites/default/files").toBe(true);
    expect(Schema.decodeUnknownSync(RemoteConfig)(decoded.remotes?.pantheon).source).toBe("pantheon");
    expect(Schema.decodeUnknownSync(DatasetBinding)(decoded.sync?.database).service === "db").toBe(true);
  });

  test("strict decoding rejects malformed remote entries", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      {
        name: "myapp",
        remotes: { pantheon: { site: "missing-source" } },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((row) => row.path.join(".") === "remotes.pantheon.source")).toBe(true);
    }
  });

  test("strict decoding rejects malformed dataset binding entries", () => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      {
        name: "myapp",
        sync: { database: { service: 123 } },
      },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((row) => row.path.join(".") === "sync.database.service")).toBe(true);
    }
  });
});

describe("LandofileShape (MVP)", () => {
  test("decodes a minimal Landofile with one app name + one service block + Compose-subset keys", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)(minimalLandofileFixture);
    expect(decoded.name).toBe("myapp");
    const web = decoded.services?.[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect(web.image).toBe("node:20");
    expect(web.ports).toEqual([{ target: 3000, published: 3000, protocol: "tcp" }]);
    expect(web.environment).toEqual({ NODE_ENV: "development" });
    expect(web.volumes).toEqual([
      { type: "bind", source: "./src", target: "/app", readOnly: false, createHostPath: true },
    ]);
    expect(web.command).toBe("npm start");
    expect(web.dependsOn).toEqual([{ service: "db" }]);
  });

  test("ServiceConfig exposes every MVP Compose-subset key as an optional field", () => {
    const fields = Object.keys(ServiceConfig.fields);
    for (const key of MVP_COMPOSE_SUBSET) {
      expect(fields).toContain(key);
    }
  });

  test("ServiceConfig ports, expose, and volumes round-trip through encode", () => {
    const decoded = Schema.decodeUnknownSync(ServiceConfig)(
      {
        ports: [
          "8080:80",
          {
            target: 443,
            published: "8443",
            host_ip: "127.0.0.1",
            protocol: "tcp",
            name: "https",
            app_protocol: "https",
          },
        ],
        expose: ["3000-3001", 9229],
        volumes: [
          "./src:/app:ro",
          {
            type: "volume",
            source: "cache",
            target: "/cache",
            read_only: true,
            volume: { subpath: "npm" },
          },
        ],
      },
      { onExcessProperty: "error" },
    );

    const encoded = Schema.encodeSync(ServiceConfig)(decoded);

    for (const entry of encoded.ports ?? []) {
      expect(typeof entry).toBe("object");
      expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    }
    for (const entry of encoded.volumes ?? []) {
      expect(typeof entry).toBe("object");
      expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    }
    expect(Schema.decodeUnknownSync(ServiceConfig)(encoded)).toEqual(decoded);
  });

  test("ServiceConfig rejects Compose keys rejected in the disposition matrix", () => {
    const rejectedFields = [
      {
        service: { ports: [{ target: 80, mode: "host" }] },
        propertyPath: "services.web.ports.0.mode",
      },
      {
        service: {
          volumes: [{ type: "bind", source: ".", target: "/a", consistency: "cached" }],
        },
        propertyPath: "services.web.volumes.0.consistency",
      },
    ] as const;

    for (const { service, propertyPath } of rejectedFields) {
      const result = Schema.decodeUnknownEither(LandofileShape)(
        { name: "myapp", services: { web: service } },
        { onExcessProperty: "error" },
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
        expect(issues.some((row) => row.path.join(".") === propertyPath)).toBe(true);
      }
    }
  });

  test("ToolingTaskShape accepts task, flag, and arg deprecation notices", () => {
    const notice = {
      since: "4.2.0",
      severity: "warn" as const,
      note: "Use the replacement tooling surface.",
    };

    const decoded = Schema.decodeUnknownSync(ToolingTaskShape)({
      service: "appserver",
      cmd: "legacy",
      deprecated: notice,
      flags: {
        legacy: {
          type: "boolean",
          description: "Legacy flag",
          deprecated: notice,
        },
      },
      args: {
        target: {
          description: "Legacy arg",
          deprecated: notice,
        },
      },
    });

    expect(decoded.deprecated).toEqual(notice);
    expect(decoded.flags?.legacy?.deprecated).toEqual(notice);
    expect(decoded.args?.target?.deprecated).toEqual(notice);
  });

  test("strict decoding rejects Compose keys outside the MVP allowlist", () => {
    const withDisallowedKey = {
      name: "myapp",
      services: {
        web: {
          image: "node:20",
          unsupported: true,
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
      const rejectionRow = issues.find((row) => row.path.includes("unsupported"));
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
          unsupported: true,
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
    expect(err.message).toContain("unsupported");
    expect(err.issues).toContain("services.web.unsupported");
  });

  test("non-strict decoding strips unknown keys by default", () => {
    const withDisallowedKey = {
      name: "myapp",
      services: {
        web: {
          image: "node:20",
          unsupported: true,
        },
      },
    };

    const decoded = Schema.decodeUnknownSync(LandofileShape)(withDisallowedKey);
    const web = decoded.services?.[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect((web as Record<string, unknown>).unsupported).toBeUndefined();
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

  test("telemetry.enabled defaults to true when omitted from the input", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      telemetry: {},
    });
    expect(decoded.telemetry?.enabled).toBe(true);
  });

  test("agentEnv.enabled is documented as default true in the public schema", () => {
    const jsonSchema = getJsonSchema("AgentEnvConfig") as {
      readonly properties?: { readonly enabled?: { readonly default?: unknown } };
    };
    expect(jsonSchema.properties?.enabled?.default).toBe(true);
  });

  test("decodes an empty object (every field is optional at MVP)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({});
    expect(decoded.telemetry.enabled).toBe(true);
    expect(decoded.allowLoadOutsideRoot).toBe(false);
    expect(decoded.loadMaxFileBytes).toBe(1_048_576);
    expect(decoded.loadMaxFilesPerExpression).toBe(16);
    expect(decoded.loadMaxRecursionDepth).toBe(4);
  });

  test("defaultProviderId accepts an explicit null (opt-out signal)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: null });
    expect(decoded.defaultProviderId).toBeNull();
  });
});

describe("ServiceConfig — ports numeric coercion (bugbot PR#28 finding 2)", () => {
  test("decodes ports: [8080] (bare integer) as a canonical target", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: [8080] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual([{ target: 8080, protocol: "tcp" }]);
  });

  test('decodes ports: ["8080:80"] (string mapping) as a canonical published port', () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: ["8080:80"] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual([{ target: 80, published: 8080, protocol: "tcp" }]);
  });

  test("decodes mixed numeric and string ports as canonical entries", () => {
    const decoded = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { image: "node:20", ports: [8080, "9000:90"] } },
    });
    const web = decoded.services?.[ServiceName.make("web")];
    expect(web?.ports).toEqual([
      { target: 8080, protocol: "tcp" },
      { target: 90, published: 9000, protocol: "tcp" },
    ]);
  });
});

describe("LandofileShape — tooling: Alpha schema", () => {
  test("strictly decodes and round-trips tooling defaults with task env and dir overrides", () => {
    // Given
    const input = {
      name: "myapp",
      toolingDefaults: {
        service: "appserver",
        dir: "/app",
        env: { APP_ENV: "development", DEBUG: false },
        vars: { MODE: "default", RETRIES: 3 },
      },
      tooling: {
        build: {
          cmd: "make",
          dir: "/app/frontend",
          env: { APP_ENV: "test", CI: true },
        },
      },
    };

    // When
    const decoded = Schema.decodeUnknownSync(LandofileShape)(input, {
      onExcessProperty: "error",
    });
    const encoded = Schema.encodeUnknownSync(LandofileShape)(decoded);

    // Then
    expect(decoded.toolingDefaults).toEqual({
      ...input.toolingDefaults,
      dir: PortablePath.make("/app"),
    });
    expect(decoded.tooling?.build?.dir).toBe(PortablePath.make("/app/frontend"));
    expect(decoded.tooling?.build?.env).toEqual({ APP_ENV: "test", CI: true });
    expect(encoded).toEqual(input);
  });

  test("strict decoding rejects unknown tooling defaults fields", () => {
    // Given
    const input = { toolingDefaults: { service: "appserver", method: "checksum" } };

    // When
    const result = Schema.decodeUnknownEither(LandofileShape)(input, {
      onExcessProperty: "error",
    });

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((row) => row.path.join(".") === "toolingDefaults.method")).toBe(true);
    }
  });

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
