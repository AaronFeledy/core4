import { describe, expect, it } from "bun:test";
import * as Errors from "@lando/sdk/errors";
import * as Contracts from "@lando/sdk/schema";
import { Either, Schema } from "effect";

describe("route filters", () => {
  for (const filter of [
    { type: "stripPrefix", name: "api", prefix: "/api" },
    { type: "addPrefix", prefix: "/v1" },
    { type: "requestHeader", name: "identity", header: "X-Request-ID", value: "request" },
    { type: "responseHeader", header: "X-Frame-Options", value: "DENY" },
    { type: "redirect", to: "/login", permanent: true },
  ] as const) {
    it(`decodes ${filter.type} when its options are valid`, () => {
      // Given a provider-neutral filter from the authored configuration.
      // When decoding the public contract.
      const result = Schema.decodeUnknownSync(Contracts.RouteFilter)(filter);
      // Then all authored options, including merge identity, survive.
      expect(result).toEqual(filter);
    });
  }

  for (const filter of [
    { type: "rewritePath", to: "/new" },
    { type: "stripPrefix", prefix: "api" },
    { type: "addPrefix", prefix: "api" },
    { type: "stripPrefix", prefix: "" },
    { type: "addPrefix", prefix: "" },
    { type: "requestHeader", header: "Bad Header", value: "x" },
    { type: "responseHeader", header: "Bad Header", value: "x" },
    { type: "requestHeader", name: "X-Header", value: "x" },
    { type: "redirect", to: "" },
  ]) {
    it(`rejects invalid filter ${JSON.stringify(filter)}`, () => {
      // Given invalid authored options.
      // When decoding the filter.
      const result = Schema.decodeUnknownEither(Contracts.RouteFilter)(filter);
      // Then validation fails.
      expect(Either.isLeft(result)).toBe(true);
    });
  }

  it("exports exactly the supported filter type ids", () => {
    // Given the public discriminator schema.
    // When inspecting its literal values.
    const types = Contracts.RouteFilterType.literals;
    // Then only the five supported ids are available.
    expect(types).toEqual(["stripPrefix", "addPrefix", "requestHeader", "responseHeader", "redirect"]);
  });
});

describe("route input and plans", () => {
  for (const input of [
    "app.lndo.site/api",
    { hostname: "app.lndo.site", filters: [{ type: "addPrefix", prefix: "/v1" }] },
  ] as const) {
    it(`accepts authored route ${JSON.stringify(input)}`, () => {
      // Given shorthand or object authoring.
      // When decoding the public route input.
      const result = Schema.decodeUnknownSync(Contracts.RouteInput)(input);
      // Then the authored form is preserved.
      expect(result).toEqual(input);
    });
  }

  it("rejects empty route shorthand", () => {
    // Given an empty shorthand.
    // When decoding the public route input.
    const result = Schema.decodeUnknownEither(Contracts.RouteInput)("");
    // Then the shorthand is rejected.
    expect(Either.isLeft(result)).toBe(true);
  });

  for (const options of [{}, { filters: [{ type: "stripPrefix", prefix: "/api" }] }] as const) {
    it(`accepts a route plan with optional filters ${JSON.stringify(options)}`, () => {
      // Given a complete backend with optional filters.
      const plan = {
        hostname: "app.lndo.site",
        scheme: "https",
        service: Contracts.ServiceName.make("appserver"),
        backend: {
          service: Contracts.ServiceName.make("appserver"),
          protocol: "http",
          port: Contracts.PortNumber.make(80),
        },
        ...options,
      } as const;
      // When decoding the route plan.
      const result = Schema.decodeUnknownSync(Contracts.RoutePlan)(plan);
      // Then filters are preserved when present and absent otherwise.
      expect(result).toEqual(plan);
    });
  }
});

describe("RouteInputError", () => {
  for (const key of ["services.appserver.routes[2]", "proxy.appserver[0]"]) {
    it(`carries remediation and the authored key ${key}`, () => {
      // Given a route failure with an authored key path.
      const fields = { message: "Invalid route", key, remediation: "Use a hostname or route object." };
      // When constructing the public tagged error.
      const error = new Errors.RouteInputError(fields);
      // Then consumers retain the tag and actionable context.
      expect(error).toMatchObject({ _tag: "RouteInputError", ...fields });
    });
  }
});
