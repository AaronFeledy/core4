import { describe, expect, test } from "bun:test";
import { landoServiceContainerName } from "@lando/sdk/schema";

import { serviceContainerName } from "../src/plan.ts";

const samples = ["web", "my/app", "my app", "user@host", "üñícode", "ok-name_1.2"] as const;

describe("serviceContainerName", () => {
  test("uses the SDK physical name for canonical and fallback inputs", () => {
    for (const slug of samples) {
      for (const service of samples) {
        const name = serviceContainerName({ slug }, service);
        expect(name).toBe(landoServiceContainerName(slug, service));
      }
    }
  });

  test("keeps the lando prefix and the separator when both parts are already safe", () => {
    expect(serviceContainerName({ slug: "myapp" }, "web")).toBe("lando-myapp--web");
  });
});
