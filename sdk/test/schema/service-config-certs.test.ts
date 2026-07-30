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

describe("ServiceConfig certs authoring", () => {
  test.each([
    ["generated leaf certs", true],
    ["disabled leaf certs", false],
    ["custom certificate path", "./certs/web.crt"],
    ["explicit certificate and key pair", { cert: "./certs/web.crt", key: "./certs/web.key" }],
  ] as const)("%s decodes through the Landofile boundary", (_name, certs) => {
    expect(decodeAuthored({ certs })).toEqual({ certs });
  });

  test.each([
    ["a number", 42],
    ["a certificate list", ["./certs/web.crt"]],
    ["a key without a certificate", { key: "./certs/web.key" }],
    ["a certificate without a key", { cert: "./certs/web.crt" }],
    ["an unknown certificate field", { cert: "./certs/web.crt", unexpected: true }],
  ])("rejects %s with a certs-scoped failure", (_name, certs) => {
    const result = Schema.decodeUnknownEither(LandofileShape)(
      { name: "app", services: { web: { certs } } },
      { onExcessProperty: "error" },
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.message).toContain("certs");
  });

  test("leaf certs and additional certificate authorities stay independent", () => {
    const service = decodeAuthored({
      certs: { cert: "./certs/web.crt", key: "./certs/web.key" },
      security: { ca: ["./certs/corp-ca.pem"], inheritNetworkCa: false },
    });

    expect(service.certs).toEqual({ cert: "./certs/web.crt", key: "./certs/web.key" });
    expect(service.security).toEqual({ ca: ["./certs/corp-ca.pem"], inheritNetworkCa: false });
  });

  test("certs alone leaves security undefined", () => {
    expect(decodeAuthored({ certs: true })).toEqual({ certs: true });
  });

  test("security.ca alone leaves certs undefined", () => {
    expect(decodeAuthored({ security: { ca: ["./certs/corp-ca.pem"] } })).toEqual({
      security: { ca: ["./certs/corp-ca.pem"] },
    });
  });

  test("omitted certs leaves the decoded service unchanged", () => {
    expect(decodeAuthored({ type: "node" })).toEqual({ type: "node" });
  });

  test.each([{}, { onExcessProperty: "error" } as const])(
    "canonical certs survives a second decode with %j",
    (options) => {
      const expected = { certs: { cert: "./certs/web.crt", key: "./certs/web.key" } };
      const once = Schema.decodeUnknownSync(ServiceConfig)(expected);

      expect(once).toEqual(expected);
      expect(Schema.decodeUnknownSync(ServiceConfig)(once, options)).toEqual(once);
    },
  );

  test.each(["ServiceConfig", "ServiceConfigInput"] as const)(
    "%s public JSON Schema publishes the certs shapes",
    (name) => {
      const certs = JSON.stringify(schemaProperties(name).certs);

      expect(certs).toContain('"boolean"');
      expect(certs).toContain('"cert"');
      expect(certs).toContain('"key"');
      expect(certs).toContain('"required":["cert","key"]');
    },
  );
});
