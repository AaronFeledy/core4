import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { compileAuthoredMounts } from "../../src/planner/authored-mounts.ts";

const context = { appRoot: "/canonical/app", appSlug: "app", serviceName: "web" };

const cases: ReadonlyArray<{
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly refused?: ReadonlyArray<string | number>;
}> = [
  {
    name: "a bind above the helper directory",
    config: { mounts: [{ source: "./x", target: "/run/lando" }] },
    refused: ["services", "web", "mounts", 0],
  },
  {
    name: "storage inside the helper directory",
    config: { storage: ["/run/lando/helper/cache"] },
    refused: ["services", "web", "storage", 0],
  },
  {
    name: "a tmpfs at the helper directory",
    config: { tmpfs: ["/run/lando/helper"] },
    refused: ["services", "web", "tmpfs", 0],
  },
  {
    name: "a non-canonical helper command target",
    config: { mounts: [{ source: "./x", target: "/usr/local//bin/lando-create-project/" }] },
    refused: ["services", "web", "mounts", 0],
  },
  { name: "a tmpfs above the helper directory", config: { tmpfs: ["/run"] } },
  {
    name: "a bind above the helper commands",
    config: { mounts: [{ source: "./bin", target: "/usr/local/bin" }] },
  },
  {
    name: "a bind at the profile stub",
    config: { mounts: [{ source: "./p.sh", target: "/etc/profile.d/zz-lando-service-path.sh" }] },
  },
];

for (const { name, config, refused } of cases)
  test(`planning ${refused === undefined ? "accepts" : "refuses"} ${name}`, () => {
    // Given
    const decoded = Schema.decodeUnknownSync(ServiceConfig)(config);
    // When
    const result = compileAuthoredMounts(context, decoded, decoded.storage);
    // Then
    if (refused === undefined) {
      expect(result).not.toBeInstanceOf(LandofileValidationError);
      return;
    }
    expect(result).toBeInstanceOf(LandofileValidationError);
    if (result instanceof LandofileValidationError) {
      expect(result.issues?.map((issue) => issue.path)).toEqual([refused]);
    }
  });
