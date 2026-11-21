import { expect, test } from "bun:test";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ConfigExpressionError, LandofileValidationError, RouteInputError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { attributePlanningFailure } from "../../src/planner/failure-attribution.ts";

const file = "/app/.lando.ts";
const typePath = ["services", "web", "type"];
const planPath = ["services", "web", "pluginEndpoints", "http"];
const load = loadAuthoredDocuments(
  [{ file, value: { name: "attributed", services: { web: { type: "nginx" } } } }],
  { appRoot: "/app", file },
);

test.each([false, true])(
  "uses only the primary issue's source (synthetic first: %s)",
  async (syntheticFirst) => {
    const landofile = await Effect.runPromise(load);
    const explicit = {
      path: typePath,
      message: "Invalid package declaration.",
      source: { layer: "project-file", file: "/app/package.json", path: ["engines", "node"] } as const,
    };
    const synthetic = { path: planPath, message: "Invalid generated endpoint." };
    const authored = { path: typePath, message: "Invalid service type." };
    const issues = syntheticFirst ? [synthetic, explicit, authored] : [explicit, synthetic, authored];
    const cause = new Error("Service configuration failed.");

    const attributed = attributePlanningFailure(
      new LandofileValidationError({
        file: "/app",
        message: cause.message,
        remediation: "Correct the reported values.",
        issues,
        cause,
      }),
      { landofile },
    );

    expect(attributed).toBeInstanceOf(LandofileValidationError);
    expect(attributed.file).toBe(syntheticFirst ? file : explicit.source.file);
    expect(attributed.cause).toBe(cause);
    const located = { ...authored, source: { layer: "canonical", file, path: typePath } };
    expect(attributed.issues).toEqual(
      syntheticFirst ? [synthetic, explicit, located] : [explicit, synthetic, located],
    );
  },
);

test("preserves an expression's explicit source instead of the effective coordinate's origin", async () => {
  const landofile = await Effect.runPromise(load);
  const source = { layer: "local", file: "/app/.lando.local.yml", path: ["serviceType"] } as const;
  const error = new ConfigExpressionError({
    filePath: file,
    source,
    path: typePath,
    expression: "{{ vars.type }}",
    message: "Invalid expression result.",
    remediation: "Return a supported service type.",
  });

  const attributed = attributePlanningFailure(error, { landofile });

  expect(attributed).toBeInstanceOf(ConfigExpressionError);
  expect(attributed).toMatchObject({ filePath: source.file, source, path: typePath });
});

test("uses the discovered file for a route error without a file and keeps explicit route files", async () => {
  const landofile = await Effect.runPromise(load);
  const details = {
    path: ["routes", 0],
    otherPath: ["routes", 1],
    message: "Invalid route.",
    remediation: "Correct the route.",
  };
  const located = new RouteInputError({ ...details, file: "/app/routes.yml" });
  expect(attributePlanningFailure(new RouteInputError(details), { landofile })).toMatchObject({
    _tag: "RouteInputError",
    file,
    path: details.path,
  });
  expect(attributePlanningFailure(located, { landofile })).toBe(located);
});

test("attributes a missing field to the authored object that omits it, not to generated paths", async () => {
  const landofile = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file,
          value: { name: "attributed", services: { web: { type: "nginx", healthcheck: { kind: "http" } } } },
        },
      ],
      { appRoot: "/app", file },
    ),
  );
  const attributed = attributePlanningFailure(
    new LandofileValidationError({
      file: "/app",
      message: "Service web has an invalid healthcheck probe.",
      remediation: "Supply an absolute HTTP or HTTPS URL.",
      issues: [
        { path: ["services", "web", "healthcheck", "url"], message: "Supply an absolute HTTP or HTTPS URL." },
        { path: planPath, message: "Invalid generated endpoint." },
      ],
    }),
    { landofile },
  );
  expect(attributed).toBeInstanceOf(LandofileValidationError);
  if (!(attributed instanceof LandofileValidationError)) return;
  expect(attributed.file).toBe(file);
  expect(attributed.issues.map((issue) => issue.source?.path)).toEqual([
    ["services", "web", "healthcheck"],
    undefined,
  ]);
});
