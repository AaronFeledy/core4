import { describe, expect, test } from "bun:test";

import { serviceContainerName } from "../src/plan.ts";

const samples = ["web", "my/app", "my app", "user@host", "üñícode", "ok-name_1.2"] as const;

/** The expression previously inlined at each call site. */
const inlineName = (slug: string, service: string): string =>
  `lando-${slug}-${service}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

/** data-plane sanitized the slug and the service separately before joining them. */
const separateName = (slug: string, service: string): string => {
  const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_.-]/gu, "-");
  return `lando-${sanitize(slug)}-${sanitize(service)}`;
};

describe("serviceContainerName", () => {
  test("matches the old inline expression and separate sanitization", () => {
    for (const slug of samples) {
      for (const service of samples) {
        const name = serviceContainerName({ slug }, service);
        expect(name).toBe(inlineName(slug, service));
        expect(name).toBe(separateName(slug, service));
      }
    }
  });

  test("keeps the lando prefix and the separator when both parts are already safe", () => {
    expect(serviceContainerName({ slug: "myapp" }, "web")).toBe("lando-myapp-web");
  });
});
