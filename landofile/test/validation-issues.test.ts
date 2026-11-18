import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { formatValidationIssuePath } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";

import { loadLandofileFile } from "../src/service.ts";
import { landofileValidationError, validateLandofile } from "../src/validation.ts";

describe("Landofile validation issues", () => {
  test("retains remediation as a machine field rather than only message text", () => {
    // Given
    const framing = {
      headline: "Invalid port",
      remediation: "Set services.web.port to a number, or remove the local override.",
    };
    // When
    const result = landofileValidationError(
      "/app/.lando.yml",
      [{ path: ["services", "web", "port"], message: "Expected number." }],
      framing,
    );
    // Then
    expect(result).toHaveProperty("remediation", framing.remediation);
    expect(result.message).not.toContain(framing.remediation);
  });

  test("uses the primary issue's authored source as the top-level error file", () => {
    // Given
    const source = {
      file: "/app/.lando.local.yml",
      layer: "local" as const,
      path: ["services", "web", "port"],
    };
    // When
    const result = landofileValidationError("/app/.lando.yml", [
      { path: source.path, message: "Expected number.", source },
    ]);
    // Then
    expect(result.file).toBe(source.file);
    expect(result.issues[0]).toHaveProperty("source", source);
  });

  test("preserves the closest-key suggestion when an unknown key contains a planner expression", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-unknown-planner-key-"));
    const file = join(root, ".lando.yml");
    try {
      await writeFile(file, 'name: typo\nservices:\n  web:\n    primry: "{{ app.name }}"\n');
      // When
      const result = await Effect.runPromise(loadLandofileFile(file).pipe(Effect.result));
      // Then
      if (result._tag !== "Failure" || result.failure._tag !== "LandofileValidationError") {
        throw new Error("Expected Landofile validation failure");
      }
      expect(result.failure.issues).toContainEqual(
        expect.objectContaining({
          path: ["services", "web", "primry"],
          suggestion: 'Did you mean "primary"?',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    [{ services: { web: { primary: "maybe" } } }, "invalid values"],
    [{ services: { web: { primary: "maybe", imgae: "node" } } }, "unknown keys and invalid values"],
    [{ services: { web: { imgae: "node" } } }, "unknown keys"],
  ])("classifies schema issues for %j", async (value, headline) => {
    // Given / When
    const error = await Effect.runPromise(validateLandofile("/app/.lando.yml", value).pipe(Effect.flip));
    // Then
    expect(error.message).toContain(headline);
    expect(error.message).not.toContain("MVP");
    expect(error.message).not.toContain("Remove unsupported keys");
    expect(error.message).not.toContain("?.");
    expect(error.message).not.toContain("..");
  });

  test("joins issue sentences without doubled periods or question-period endings", () => {
    // Given
    const issues = [
      { path: ["a"], message: "Bad value." },
      { path: ["imgae"], message: "Unknown key.", suggestion: 'Did you mean "image"?' },
    ];
    // When
    const result = landofileValidationError("/app/.lando.yml", issues);
    // Then
    expect(result.message).toBe(
      'Landofile has invalid values: a: Bad value; imgae: Unknown key. Did you mean "image"?',
    );
    expect(result.message).not.toContain("?.");
    expect(result.message).not.toContain("..");
  });
  test("reports three independent problems with paths and an image suggestion", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lando-validation-issues-"));
    const file = join(appRoot, ".lando.yml");
    try {
      await writeFile(
        file,
        [
          "name: config-lint-invalid",
          "services:",
          "  web:",
          "    type: compose",
          "    imgae: nginx:1.27-alpine",
          '    home: "nope"',
          "    ports:",
          "      - target: 99999",
          "        protocol: tcp",
          "",
        ].join("\n"),
      );
      const exit = await Effect.runPromiseExit(loadLandofileFile(file));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (!Option.isSome(failure) || !(failure.value instanceof LandofileValidationError)) {
        throw new Error("expected LandofileValidationError");
      }
      const paths = failure.value.issues.map((issue) => formatValidationIssuePath(issue.path));
      expect(paths).toContain("services.web.imgae");
      expect(paths).toContain("services.web.home");
      expect(paths).toContain("services.web.ports[0].target");
      expect(failure.value.issues.find((issue) => issue.path.at(-1) === "imgae")?.suggestion).toBe(
        'Did you mean "image"?',
      );
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});

describe("service-level database and password point at the key their service type reads", () => {
  const issuesFor = async (value: unknown) => {
    const error = await Effect.runPromise(validateLandofile("/app/.lando.yml", value).pipe(Effect.flip));
    if (error._tag !== "LandofileValidationError") throw new Error("expected LandofileValidationError");
    return error.issues;
  };

  test("services.<name>.database suggests creds.database", async () => {
    const issues = await issuesFor({ services: { db: { type: "postgres:16", database: "appdata" } } });
    const issue = issues.find((candidate) => candidate.path.at(-1) === "database");
    expect(issue?.path).toEqual(["services", "db", "database"]);
    expect(issue?.suggestion).toContain("creds.database");
  });

  test("a service type that reads neither key gets no pointer to creds", async () => {
    const issues = await issuesFor({
      services: { mq: { type: "rabbitmq:4", database: "orders", password: "hunter2" } },
    });
    const suggestions = issues
      .filter((candidate) => candidate.path[1] === "mq")
      .map((candidate) => candidate.suggestion ?? "");
    expect(suggestions).toHaveLength(2);
    for (const suggestion of suggestions) {
      expect(suggestion).not.toContain("creds.");
      expect(suggestion).not.toContain("bucket");
      expect(suggestion).not.toContain("hunter2");
    }
  });

  test("services.<name>.database suggests bucket on a MinIO service", async () => {
    const issues = await issuesFor({ services: { store: { type: "minio", database: "uploads" } } });
    const issue = issues.find((candidate) => candidate.path.at(-1) === "database");
    expect(issue?.path).toEqual(["services", "store", "database"]);
    expect(issue?.suggestion).toContain("bucket");
    expect(issue?.suggestion).not.toContain("creds.database");
  });

  test("services.<name>.password suggests creds.password without echoing the value", async () => {
    const issues = await issuesFor({ services: { cache: { type: "redis", password: "hunter2" } } });
    const issue = issues.find((candidate) => candidate.path.at(-1) === "password");
    expect(issue?.path).toEqual(["services", "cache", "password"]);
    expect(issue?.suggestion).toContain("creds.password");
    expect(JSON.stringify(issue)).not.toContain("hunter2");
  });
});

describe("validation error summaries name the source that failed", () => {
  const projectIssue = (file: string, path: ReadonlyArray<string | number>, message: string) => ({
    path: ["services", "web"],
    message,
    source: { layer: "project-file" as const, file, path },
  });

  test("names a single project file by its app-relative path", () => {
    const error = landofileValidationError("/app/.lando.yml", [
      projectIssue(
        "/app/package.json",
        ["packageManager"],
        "packageManager names bun, which Lando cannot provision.",
      ),
    ]);
    expect(error.message).toBe(
      "package.json has invalid values: services.web: packageManager names bun, which Lando cannot provision (package.json: packageManager).",
    );
    expect(error.file).toBe("/app/package.json");
    expect(error.issues[0]?.source).toEqual({
      layer: "project-file",
      file: "/app/package.json",
      path: ["packageManager"],
    });
  });

  test("keeps a nested project file path relative to the app root", () => {
    const error = landofileValidationError("/app/.lando.yml", [
      projectIssue("/app/apps/web/package.json", ["packageManager"], "Invalid manager."),
    ]);
    expect(error.message).toContain("apps/web/package.json has invalid values");
  });

  test("names several project files without claiming a single one", () => {
    const error = landofileValidationError("/app/.lando.yml", [
      projectIssue("/app/apps/web/package.json", [], "Invalid manager."),
      projectIssue("/app/package.json", [], "Invalid Node constraint."),
    ]);
    expect(error.message).toContain("Project files have invalid values");
    expect(error.file).toBe("/app/apps/web/package.json");
  });

  test("uses a neutral summary when sources are mixed", () => {
    const error = landofileValidationError("/app/.lando.yml", [
      { path: ["services", "web", "type"], message: "Unsupported service type." },
      projectIssue("/app/package.json", [], "Invalid manager."),
    ]);
    expect(error.message).toContain("Configuration has invalid values");
  });

  test("keeps the Landofile summary when every issue is authored", () => {
    const error = landofileValidationError("/app/.lando.yml", [
      { path: ["services", "web", "type"], message: "Unsupported service type." },
      {
        path: ["services", "db", "port"],
        message: "Invalid port.",
        source: { layer: "local" as const, file: "/app/.lando.yml", path: ["services", "db", "port"] },
      },
    ]);
    expect(error.message).toContain("Landofile has invalid values");
  });

  test("preserves explicit framing for a non-value failure", () => {
    const error = landofileValidationError(
      "/app/config.yml",
      [projectIssue("/app/package.json", [], "Invalid manager.")],
      {
        headline: "Global config hostEvents has steps that cannot run as written",
        remediation: "Fix each step.",
      },
    );
    expect(error.message).toContain("Global config hostEvents has steps that cannot run as written");
    expect(error.remediation).toBe("Fix each step.");
  });
});

describe("project-file human paths use app root and escape controls", () => {
  const projectIssue = (file: string, path: ReadonlyArray<string | number>, message: string) => ({
    path: ["services", "web"],
    message,
    source: { layer: "project-file" as const, file, path },
  });

  test("bases the headline on framing.appRoot when the Landofile lives outside the app", () => {
    // Given: embedding callers may pass a config file outside the app root
    const landofileOutside = "/config/embedding/landofile.yml";
    const appRoot = "/app";
    // When
    const error = landofileValidationError(
      landofileOutside,
      [projectIssue("/app/package.json", ["packageManager"], "Invalid manager.")],
      { appRoot },
    );
    // Then: app-relative, not ../app/package.json from dirname(landofile)
    expect(error.message.startsWith("package.json has invalid values")).toBe(true);
    expect(error.message).not.toContain("../");
    expect(error.file).toBe("/app/package.json");
    expect(error.issues[0]?.source).toEqual({
      layer: "project-file",
      file: "/app/package.json",
      path: ["packageManager"],
    });
  });

  test("escapes control characters only in the human path, leaving structured paths raw", () => {
    // Given
    const rawFile = `/app/pack${String.fromCharCode(10)}age.json`;
    // When
    const error = landofileValidationError(
      "/app/.lando.yml",
      [projectIssue(rawFile, ["packageManager"], "Invalid manager.")],
      { appRoot: "/app" },
    );
    // Then
    expect(error.message).toContain("pack\\u000aage.json has invalid values");
    expect(error.message).toContain("(pack\\u000aage.json: packageManager)");
    expect(error.message).not.toContain(`pack${String.fromCharCode(10)}age`);
    expect(error.file).toBe(rawFile);
    expect(error.issues[0]?.source).toMatchObject({ layer: "project-file", file: rawFile });
  });

  test("defaults display base to dirname(file) when appRoot is omitted", () => {
    // Given / When: same-directory Landofile keeps prior relative behavior
    const error = landofileValidationError("/app/.lando.yml", [
      projectIssue("/app/apps/web/package.json", [], "Invalid manager."),
    ]);
    // Then
    expect(error.message).toContain("apps/web/package.json has invalid values");
  });
});
