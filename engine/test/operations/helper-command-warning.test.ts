import { expect, test } from "bun:test";
import { type MountPlan, PortablePath, ServiceName } from "@lando/sdk/schema";
import { selectHelperCommandWarnings } from "../../src/operations/helper-command-warning.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const bind = (target: string): MountPlan => ({
  type: "bind",
  origin: "authored",
  source: "/host/dir",
  realization: "passthrough",
  target: PortablePath.make(target),
  readOnly: false,
});
const hostProxy = { "@lando/core/service-features": { featureIds: ["lando.host-proxy"] } };
const scaffold =
  "lando-create-project, lando-drupal-scaffold, lando-drupal-cms-scaffold, lando-drupal-contrib-sync";

const cases: ReadonlyArray<{
  readonly name: string;
  readonly mounts: ReadonlyArray<MountPlan>;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly expected: ReadonlyArray<Readonly<Record<string, string>>>;
}> = [
  { name: "no covering mount", mounts: [bind("/usr/local/bin/tool")], extensions: {}, expected: [] },
  // An exact target is a collision the provider refuses, not a skipped command.
  {
    name: "an exact command target",
    mounts: [bind("/usr/local/bin/lando-create-project")],
    extensions: {},
    expected: [],
  },
  {
    name: "a tmpfs above the commands, which persists nothing",
    mounts: [{ type: "tmpfs", target: PortablePath.make("/usr/local/bin"), readOnly: false }],
    extensions: hostProxy,
    expected: [],
  },
  {
    name: "a cover without host-proxy",
    mounts: [bind("/usr/local/bin")],
    extensions: {},
    expected: [{ service: "web", mount: "/usr/local/bin", commands: scaffold }],
  },
  {
    name: "a cover with host-proxy",
    mounts: [bind("/usr")],
    extensions: hostProxy,
    expected: [{ service: "web", mount: "/usr", commands: `lando, xdg-open, open, ${scaffold}` }],
  },
];

for (const { name, mounts, extensions, expected } of cases)
  test(`selects one helper-command warning per service for ${name}`, () => {
    // Given
    const input = { ...plan, services: { web: { ...web, mounts: [...mounts], extensions } } };
    // When
    const warnings = selectHelperCommandWarnings(input);
    // Then
    expect(warnings.map(({ code, context }) => ({ code, ...context }))).toEqual(
      expected.map((context) => ({ code: "LANDO_HELPER_COMMANDS_UNAVAILABLE", ...context })),
    );
  });

test("warns separately for each service whose mount covers the commands", () => {
  // Given
  const worker = { ...web, name: ServiceName.make("worker"), mounts: [bind("/usr/local")] };
  const input = { ...plan, services: { web: { ...web, mounts: [bind("/usr/local/bin")] }, worker } };
  // When
  const warnings = selectHelperCommandWarnings(input);
  // Then
  expect(warnings.map(({ context }) => [context?.service, context?.mount])).toEqual([
    ["web", "/usr/local/bin"],
    ["worker", "/usr/local"],
  ]);
});
