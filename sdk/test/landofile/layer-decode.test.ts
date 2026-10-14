import { expect, test } from "bun:test";
import { decodeLandofileLayer, mergeLandofiles, override, reset } from "@lando/sdk/landofile";
import { Cause, Effect } from "effect";

const decode = (value: unknown) => Effect.runSync(decodeLandofileLayer(".lando.local.yml", value));

test("canonical authored resets beat service aliases", () => {
  const result = decode({
    services: {
      web: {
        working_dir: override("/app"),
        env_file: override([".env"]),
        depends_on: ["db"],
        dependsOn: reset(),
      },
    },
  });
  expect(result).toHaveProperty(["services", "web"], {
    workingDirectory: override("/app"),
    envFile: override([".env"]),
    dependsOn: reset(),
  });
});

test("whole-field overrides wrap decoded transformed values", () => {
  const result = decode({
    services: { web: { environment: override(["FOO=bar"]), depends_on: override(["db"]) } },
  });
  expect(result).toHaveProperty(["services", "web"], {
    environment: override({ FOO: "bar" }),
    dependsOn: override([{ service: "db" }]),
  });
});

test("stable list-item members retain operations", () => {
  const result = decode({ services: { web: { routes: [{ hostname: "web.test", filters: override([]) }] } } });
  expect(result).toHaveProperty(["services", "web"], {
    routes: [{ hostname: "web.test", filters: override([]) }],
  });
});

test.each([
  { services: { web: { environmnt: reset() } } },
  { services: { web: { routes: [{ hostname: override("web.test") }] } } },
  { services: { web: { dependsOn: { db: { condition: reset() } } } } },
  {
    services: {
      web: { routes: [{ hostname: "web.test", filters: [{ type: "stripPrefix", prefix: reset() }] }] },
    },
  },
  { services: { web: { security: { cas: override(["ca.pem"]) } } } },
])("rejects unknown, identity, required, or reshaped directive paths %j", (value) => {
  expect(() => decode(value)).toThrow();
});

test("reset suppresses a decode-synthesized default", () => {
  const result = decode({
    tooling: {
      check: { cmd: "true", deprecated: { since: "4.2.0", note: "Use another task.", severity: reset() } },
    },
  });
  expect(mergeLandofiles([result])).toEqual({
    tooling: { check: { cmd: "true", deprecated: { since: "4.2.0", note: "Use another task." } } },
  });
});

test("an authored canonical key wins without promoting the losing alias", () => {
  // Given both spellings, with the canonical spelling reset.
  const result = decode({ services: { web: { working_dir: "/alias", workingDirectory: reset() } } });
  // Then only the canonical reset remains.
  expect(result).toHaveProperty(["services", "web"], { workingDirectory: reset() });
});

test("an alias-only reset maps to the canonical member", () => {
  // Given resets authored with Compose spellings; when decoded.
  const result = decode({ services: { web: { env_file: reset(), depends_on: reset() } } });
  // Then the directives land on canonical members.
  expect(result).toHaveProperty(["services", "web"], { envFile: reset(), dependsOn: reset() });
});

test.each([
  { services: { web: { environment: [reset()] } } },
  { services: { web: { dependsOn: [{ service: reset() }] } } },
  {
    services: {
      web: {
        routes: [{ hostname: "web.test", filters: [{ name: override("f"), type: "redirect", to: "/" }] }],
      },
    },
  },
  { services: override({ web: reset() }), name: override(reset()) },
])("rejects sequence-element, identity, and nested-wrapper directives %j", (value) => {
  // Given a placement that cannot survive layer decoding; when decoded.
  const exit = Effect.runSyncExit(decodeLandofileLayer(".lando.local.yml", value));
  // Then the layer fails as a tagged validation error with remediation.
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const error = Cause.findErrorOption(exit.cause);
  expect(error._tag === "Some" ? error.value._tag : undefined).toBe("LandofileValidationError");
  expect(error._tag === "Some" ? error.value.message : "").toContain("!override the containing value");
});
