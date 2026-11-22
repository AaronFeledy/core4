import { expect, test } from "bun:test";
import { decodeLandofileLayer, mergeLandofiles, override, reset } from "@lando/sdk/landofile";
import { Cause, Effect } from "effect";

const decode = (value: unknown) => Effect.runSync(decodeLandofileLayer(".lando.local.yml", value));

test("canonical authored resets beat sibling service fields", () => {
  const result = decode({
    services: {
      web: {
        working_dir: override("/app"),
        env_file: override([".env"]),
        depends_on: reset(),
      },
    },
  });
  expect(result).toHaveProperty(["services", "web"], {
    working_dir: override("/app"),
    env_file: override([".env"]),
    depends_on: reset(),
  });
});

test("whole-field overrides wrap decoded transformed values", () => {
  const result = decode({
    services: { web: { environment: override(["FOO=bar"]), depends_on: override(["db"]) } },
  });
  expect(result).toHaveProperty(["services", "web"], {
    environment: override({ FOO: "bar" }),
    depends_on: override([{ service: "db" }]),
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
  { services: { web: { endpoints: [override("ui=http:80")] } } },
  { services: { web: { endpoints: [{ kind: "internal", name: override("ui") }] } } },
  { services: { web: { routes: [{ hostname: override("web.test") }] } } },
  { services: { web: { depends_on: { db: { condition: reset() } } } } },
  {
    services: {
      web: { routes: [{ hostname: "web.test", filters: [{ kind: "stripPrefix", prefix: reset() }] }] },
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

test("an authored canonical reset is retained on the Compose member", () => {
  // Given a canonical Compose member reset.
  const result = decode({ services: { web: { working_dir: reset() } } });
  // Then the reset remains on that member.
  expect(result).toHaveProperty(["services", "web"], { working_dir: reset() });
});

test("legacy camelCase service keys are unknown authored targets", () => {
  // Given resets authored with removed Lando camelCase aliases.
  expect(() => decode({ services: { web: { envFile: reset(), dependsOn: reset() } } })).toThrow(
    "Unknown authored target key",
  );
  expect(() => decode({ services: { web: { workingDirectory: reset() } } })).toThrow(
    "Unknown authored target key",
  );
  // A foreign camelCase sibling next to a canonical member still fails layer admission.
  expect(() => decode({ services: { web: { workingDirectory: "/alias", working_dir: reset() } } })).toThrow(
    "Invalid Landofile layer",
  );
});

test.each([
  { services: { web: { environment: [reset()] } } },
  { services: { web: { depends_on: [{ service: reset() }] } } },
  {
    services: {
      web: {
        routes: [{ hostname: "web.test", filters: [{ name: override("f"), kind: "redirect", to: "/" }] }],
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
