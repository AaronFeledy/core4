import { describe, expect, test } from "bun:test";
import { projectInitReviewRoutes } from "../../src/cli/commands/init-review-routes";
import { INIT_REVIEW_LIMIT } from "../../src/cli/commands/init-review-sites";
import { reviewWith } from "./init-review-fixtures";

describe("prepared init route projection", () => {
  test("uses final recipe options and canonical ingress precedence, not the selected backend port", () => {
    const review = reviewWith({
      recipe: { options: { hostname: "chosen.example", httpsPort: 9443 } },
      router: { httpsPort: "{{ recipe.httpsPort }}" },
      services: {
        web: {
          type: "node:22",
          endpoints: [{ _tag: "internal", protocol: "http", port: 3000, name: "web" }],
          routes: [
            { hostname: "{{ recipe.hostname }}", scheme: "both", endpoint: "web", pathPrefix: "/preview" },
          ],
        },
      },
    });
    const routes = projectInitReviewRoutes(review, { router: { httpPort: 8088, httpsPort: 8444 } });
    expect(routes.candidates).toEqual([
      { service: "web", url: "http://chosen.example:8088/preview" },
      { service: "web", url: "https://chosen.example:9443/preview" },
    ]);
    expect(routes.services).toEqual([{ name: "web", type: "node:22" }]);
  });

  test.each([
    [{ services: { web: { routes: ["chosen.example"] } } }, {}, "candidate"],
    [{ services: { database: { type: "postgres" } } }, {}, "none"],
    [{ services: { web: { routes: ["{{ env.HOST }}"] } } }, {}, "unresolved"],
    [{ router: { enabled: false }, services: { web: { routes: ["chosen.example"] } } }, {}, "disabled"],
    [{ services: { web: { routes: ["chosen.example"] } } }, undefined, "unavailable"],
  ] as const)("distinguishes configured route state for %j", (source, config, status) => {
    const review = reviewWith(source);
    const result = projectInitReviewRoutes(review, config);
    expect(result.status).toBe(status);
  });

  test("uses the final app identity and invocation proxy domain", () => {
    const review = reviewWith({
      services: { web: { routes: ["{{ app.name }}.{{ proxy.defaultDomain }}"] } },
    });
    const result = projectInitReviewRoutes(review, { proxy: { defaultDomain: "configured.test" } });
    expect(result.candidates).toEqual([{ service: "web", url: "https://chosen-app.configured.test" }]);
  });

  test("lets app routing enablement override global disablement", () => {
    const review = reviewWith({
      router: { enabled: true },
      services: { web: { routes: ["chosen.example"] } },
    });
    const result = projectInitReviewRoutes(review, { router: { enabled: false } });
    expect(result.status).toBe("candidate");
  });

  test("retains source order, deduplicates URLs, and admits partial uncertainty", () => {
    const review = reviewWith({
      services: {
        second: { routes: ["two.example", "{{ env.HOST }}", "two.example"] },
        first: { routes: ["one.example"] },
      },
      proxy: { first: ["legacy.example"] },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.candidates.map(({ url }) => url)).toEqual([
      "https://two.example",
      "https://one.example",
      "https://legacy.example",
    ]);
    expect(result.unresolved).toBe(1);
  });

  test("does not treat raw option-produced binding text as a second expression", () => {
    const review = reviewWith({
      recipe: { options: { injected: "{{ app.name }}.example" } },
      services: { web: { routes: [{ hostname: "{{ recipe.injected }}" }] } },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.status).toBe("unresolved");
    expect(result.candidates).toEqual([]);
  });

  test("does not pick a backend when the authored endpoints are ambiguous", () => {
    const review = reviewWith({
      services: {
        web: {
          endpoints: [
            { _tag: "internal", protocol: "http", port: 3000 },
            { _tag: "internal", protocol: "http", port: 3001 },
          ],
          routes: ["chosen.example"],
        },
      },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.status).toBe("unresolved");
  });

  test("honors an explicit numeric backend selector without exposing it as the ingress port", () => {
    const review = reviewWith({
      services: {
        web: {
          endpoints: [
            { _tag: "internal", protocol: "http", port: 3000 },
            { _tag: "internal", protocol: "http", port: 3001 },
          ],
          routes: ["chosen.example:3001/api"],
        },
      },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.candidates).toEqual([{ service: "web", url: "https://chosen.example/api" }]);
  });

  test("reports bounded truncation instead of presenting an incomplete preview as complete", () => {
    const review = reviewWith({
      services: {
        web: { routes: Array.from({ length: INIT_REVIEW_LIMIT + 1 }, (_, index) => `host-${index}.example`) },
      },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.candidates).toHaveLength(INIT_REVIEW_LIMIT);
    expect(result.truncated).toBe(true);
  });

  test("never guesses concrete hosts for wildcards or undeclared proxy targets", () => {
    const review = reviewWith({
      services: { web: { routes: ["*.example"] } },
      proxy: { absent: ["other.example"] },
    });
    const result = projectInitReviewRoutes(review, {});
    expect(result.candidates).toEqual([]);
    expect(result.unresolved).toBe(2);
  });
});
