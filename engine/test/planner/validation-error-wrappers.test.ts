import { expect, test } from "bun:test";
import { taggedErrorJson } from "@lando/sdk/command-result";
import {
  AppFeatureMutationConflictError,
  LandofileValidationError,
  MailpitMsmtpBaseFamilyError,
  ServiceTypeError,
} from "@lando/sdk/errors";
import { appFeatureError } from "../../src/planner/app-feature-error.ts";
import { servicePlanError } from "../../src/planner/service-types.ts";

const wrappers = [
  {
    name: "servicePlanError",
    wrap: (cause: unknown) => servicePlanError({ appRoot: "/app", serviceName: "web", cause }),
    path: ["services", "web"],
    fallback: "Invalid service web.",
    remediation: "Correct the configuration of service web.",
  },
  {
    name: "appFeatureError",
    wrap: (cause: unknown) => appFeatureError("/app", cause),
    path: ["appFeatures"],
    fallback: "Invalid app-feature composition.",
    remediation: "Correct the app-feature configuration or remove the failing feature.",
  },
];

test.each([
  new MailpitMsmtpBaseFamilyError({
    feature: "service-lando.mailpit.wire",
    service: "web",
    reason: "replacement-build",
    message: "The replacement build controls the sender filesystem.",
    remediation: "Exclude web with mailFrom: false, or use a known image without a replacement build.",
  }),
  new AppFeatureMutationConflictError({
    feature: "synthetic",
    service: "web",
    field: "resolutionMetadata",
    existing: "old-private-value",
    incoming: "new-private-value",
    message: "Resolved policy is invalid.",
    remediation: "Preserve the service type's resolution metadata.",
  }),
])("preserves a tagged app-feature failure and its recovery across planning: %j", (cause) => {
  // Given / When: a declared app-feature failure crosses the planner boundary.
  const result = appFeatureError("/app", cause);
  // Then: the outer classification does not discard the tagged cause or its recovery.
  expect(result.cause).toBe(cause);
  expect(result.remediation).toBe(cause.remediation);
  expect(result.issues[0]?.suggestion).toBe(cause.remediation);
  expect(JSON.parse(JSON.stringify(result)).cause).toMatchObject({ _tag: cause._tag, service: "web" });
  expect(taggedErrorJson(result).context).toMatchObject({ _tag: cause._tag, service: "web" });
  const diagnostic = taggedErrorJson(result);
  expect(diagnostic.cause).toMatchObject({ _tag: cause._tag, message: cause.message });
  expect(JSON.stringify(diagnostic)).not.toContain("old-private-value");
  expect(JSON.stringify(diagnostic)).not.toContain("new-private-value");
});

test("service type field issues are prefixed without losing their suggestions", () => {
  const error = new ServiceTypeError({
    serviceType: "synthetic",
    message: "Bad listener",
    issues: [
      { path: ["environment", "PGPORT"], message: "Use port", suggestion: "Set port: 5433" },
      { path: ["port"], message: "Reserved port" },
    ],
    remediation: "Set port: 5433",
  });
  expect(servicePlanError({ appRoot: "/app", serviceName: "db", cause: error }).issues).toEqual([
    { path: ["services", "db", "environment", "PGPORT"], message: "Use port", suggestion: "Set port: 5433" },
    { path: ["services", "db", "port"], message: "Reserved port", suggestion: "Set port: 5433" },
  ]);
});

test.each([{ issues: undefined }, { issues: [] }])(
  "service type errors without fields keep a service-level issue: %j",
  ({ issues }) => {
    const error = new ServiceTypeError({
      serviceType: "synthetic",
      message: "Bad service",
      ...(issues === undefined ? {} : { issues }),
      remediation:
        "Correct the `synthetic` service configuration in the Landofile (see the reported field path), then re-run.",
    });
    expect(servicePlanError({ appRoot: "/app", serviceName: "db", cause: error }).issues).toEqual([
      {
        path: ["services", "db"],
        message: "Bad service",
        suggestion:
          "Correct the `synthetic` service configuration in the Landofile (see the reported field path), then re-run.",
      },
    ]);
  },
);

test.each(wrappers)("$name preserves structured validation errors by identity", ({ wrap }) => {
  // Given
  const cause = new LandofileValidationError({
    file: "/app/.lando.local.yml",
    message: "Invalid local port.",
    remediation: "Fix the local port.",
    issues: [
      {
        path: ["services", "web", "port"],
        message: "Expected number.",
        source: {
          file: "/app/.lando.local.yml",
          layer: "local",
          path: ["services", "web", "port"],
        },
      },
    ],
  });
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBe(cause);
  expect(result.file).toBe("/app/.lando.local.yml");
  expect(result.remediation).toBe("Fix the local port.");
  expect(result.issues).toEqual(cause.issues);
  expect(result.issues[0]?.source).toBe(cause.issues[0]?.source);
});

test.each(wrappers)("$name wraps an unstructured Error", ({ wrap, path, remediation }) => {
  // Given
  const cause = new Error("Plugin configuration failed.");
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBeInstanceOf(LandofileValidationError);
  expect(result.file).toBe("/app");
  expect(result.message).toBe(cause.message);
  expect(result.remediation).toBe(remediation);
  expect(result.issues).toEqual([{ path, message: cause.message }]);
});

test.each(wrappers)("$name wraps a non-Error cause", ({ wrap, path, fallback, remediation }) => {
  // Given
  const cause = { detail: "not an Error" };
  // When
  const result = wrap(cause);
  // Then
  expect(result).toBeInstanceOf(LandofileValidationError);
  expect(result.file).toBe("/app");
  expect(result.message).toBe(fallback);
  expect(result.remediation).toBe(remediation);
  expect(result.issues).toEqual([{ path, message: fallback }]);
});

const projectFileError = (file: string) =>
  new ServiceTypeError({
    serviceType: "node",
    message: '.nvmrc constraint "lts/*" conflicts with package.json engines.node "^24".',
    issues: [
      {
        path: [],
        message: '.nvmrc constraint "lts/*" conflicts with package.json engines.node "^24".',
        suggestion: "Make both project files describe compatible Node versions.",
        source: { layer: "project-file", file, path: [] },
      },
    ],
    remediation: "Make both project files describe compatible Node versions.",
  });

test("attributes a service type issue to the project file the planner read", () => {
  // Given a service type that named the declared .nvmrc.
  const cause = projectFileError(".nvmrc");
  // When the planner boundary resolves project files under the app root.
  const result = servicePlanError({
    appRoot: "/app",
    serviceName: "web",
    cause,
    projectFiles: [
      { path: ".nvmrc", present: true, text: "lts/*", sha256: "sha256:nvmrc" },
      { path: "package.json", present: true, text: "{}", sha256: "sha256:package" },
    ],
  });
  // Then the issue and the error both name the absolute project file.
  expect(result.file).toBe("/app/.nvmrc");
  expect(result.issues).toEqual([
    {
      path: ["services", "web"],
      message: '.nvmrc constraint "lts/*" conflicts with package.json engines.node "^24".',
      suggestion: "Make both project files describe compatible Node versions.",
      source: { layer: "project-file", file: "/app/.nvmrc", path: [] },
    },
  ]);
});

test("resolves a nested packageRoot project file under the app root", () => {
  const result = servicePlanError({
    appRoot: "/app",
    serviceName: "web",
    cause: projectFileError("apps/web/.nvmrc"),
    projectFiles: [{ path: "apps/web/.nvmrc", present: false }],
  });
  expect(result.file).toBe("/app/apps/web/.nvmrc");
  expect(result.issues[0]?.source).toEqual({
    layer: "project-file",
    file: "/app/apps/web/.nvmrc",
    path: [],
  });
});

test("leaves an authored service issue for planner attribution when only the app root is known", () => {
  const cause = new ServiceTypeError({
    serviceType: "synthetic",
    message: "Bad listener",
    issues: [{ path: ["port"], message: "Reserved port" }],
    remediation: "Set port: 5433",
  });
  const result = servicePlanError({ appRoot: "/app", serviceName: "db", cause });
  expect(result.file).toBe("/app");
  expect(result.issues[0]?.source).toBeUndefined();
});

test("does not name a project file the planner did not read", () => {
  const result = servicePlanError({
    appRoot: "/app",
    serviceName: "web",
    cause: projectFileError("secrets.txt"),
    projectFiles: [{ path: ".nvmrc", present: false }],
  });
  expect(result.file).toBe("/app");
  expect(result.issues[0]?.source).toBeUndefined();
});
