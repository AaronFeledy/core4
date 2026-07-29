import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { LandofileShape, ServiceConfig, ServiceName, getJsonSchema } from "../../src/schema/index.ts";

const decodeAuthored = (service: Readonly<Record<string, unknown>>): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)(
    { name: "app", services: { web: service } },
    { onExcessProperty: "error" },
  );
  const web = landofile.services?.[ServiceName.make("web")];
  if (web === undefined) throw new Error("missing web service");
  return web;
};

const schemaProperties = (
  name: "ServiceConfig" | "ServiceConfigInput",
): Readonly<Record<string, unknown>> => {
  const schema = getJsonSchema(name) as {
    readonly $defs?: Readonly<Record<string, { readonly properties?: Readonly<Record<string, unknown>> }>>;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  return schema.properties ?? schema.$defs?.[name]?.properties ?? {};
};

describe("ServiceConfig security authoring", () => {
  test("canonical CA paths and inject overrides decode through the Landofile boundary", () => {
    const service = decodeAuthored({
      security: {
        ca: ["./corp-ca.pem"],
        inheritNetworkCa: false,
        inheritNetworkProxy: true,
      },
    });

    expect(service.security).toEqual({
      ca: ["./corp-ca.pem"],
      inheritNetworkCa: false,
      inheritNetworkProxy: true,
    });
  });

  test.each([
    ["cas", "./corp-ca.pem", ["./corp-ca.pem"]],
    ["cas", ["./corp-ca.pem", "./team-ca.pem"], ["./corp-ca.pem", "./team-ca.pem"]],
    ["certificate-authority", "./corp-ca.pem", ["./corp-ca.pem"]],
    ["certificate-authority", ["./corp-ca.pem"], ["./corp-ca.pem"]],
    ["certificate-authorities", "./corp-ca.pem", ["./corp-ca.pem"]],
    ["certificate-authorities", ["./corp-ca.pem"], ["./corp-ca.pem"]],
  ] as const)("%s canonicalizes scalar or array input to ca", (alias, value, expected) => {
    expect(decodeAuthored({ security: { [alias]: value } }).security).toEqual({ ca: expected });
  });

  test("omitted security leaves the decoded service unchanged", () => {
    expect(decodeAuthored({ type: "node" })).toEqual({ type: "node" });
  });

  test.each([
    ["unknown field", { security: { ca: ["./corp-ca.pem"], unexpected: true } }],
    ["leaf certs alias", { security: { certs: ["./leaf.pem"] } }],
  ])("%s fails closed under production decode options", (_name, service) => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { name: "app", services: { web: service } },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
  });

  test.each([{}, { onExcessProperty: "error" } as const])(
    "canonical security survives a second decode with %j",
    (options) => {
      const expected = {
        security: {
          ca: ["./corp-ca.pem"],
          inheritNetworkCa: true,
          inheritNetworkProxy: false,
        },
      };
      const once = Schema.decodeUnknownSync(ServiceConfig)(expected);

      expect(once).toEqual(expected);
      expect(Schema.decodeUnknownSync(ServiceConfig)(once, options)).toEqual(once);
    },
  );

  test.each(["ServiceConfig", "ServiceConfigInput"] as const)(
    "%s public JSON Schema publishes security fields and aliases",
    (name) => {
      const security = JSON.stringify(schemaProperties(name).security);

      expect(security).toContain('"ca"');
      expect(security).toContain('"cas"');
      expect(security).toContain('"certificate-authority"');
      expect(security).toContain('"certificate-authorities"');
      expect(security).toContain('"inheritNetworkCa"');
      expect(security).toContain('"inheritNetworkProxy"');
    },
  );
});
