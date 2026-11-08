import { expect, test } from "bun:test";
import { landoAppStoreName, landoServiceStorageName } from "@lando/sdk/schema";
import { lowerApi4Mounts } from "../src/lower-api4-mounts.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";

const context: ServiceLoweringContext = {
  appSlug: "app",
  serviceFacts: {},
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

test.each(["service", "app", "project"])(
  "retains exact destination identity when deriving %s storage",
  (scope) => {
    const targets = ["/foo/bar", "/foo-bar"];
    const result = lowerApi4Mounts({ storage: targets.map((target) => ({ target, scope })) }, context);
    expect(result.patch.storage).toEqual(
      targets.map((target) => ({
        store:
          scope === "service"
            ? landoServiceStorageName("app", "web", target)
            : landoAppStoreName("app", target),
        target,
        scope: scope === "project" ? "app" : scope,
      })),
    );
  },
);
