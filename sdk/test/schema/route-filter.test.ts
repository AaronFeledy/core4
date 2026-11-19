import { describe, expect, it } from "bun:test";
import * as Errors from "@lando/sdk/errors";
import * as Contracts from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("route filters", () => {
  for (const filter of [
    { kind: "stripPrefix", name: "api", prefix: "/api" },
    { kind: "addPrefix", prefix: "/v1" },
    { kind: "requestHeader", name: "identity", header: "X-Request-ID", value: "request" },
    { kind: "responseHeader", header: "X-Frame-Options", value: "DENY" },
    { kind: "redirect", to: "/login", permanent: true },
  ] as const) {
    it(`decodes plan filter ${filter.kind} when its options are valid`, () => {
      // Given a provider-neutral plan filter.
      // When decoding the public plan contract.
      const result = Schema.decodeUnknownSync(Contracts.RouteFilter)(filter);
      // Then all options, including merge identity, survive.
      expect(result).toEqual(filter);
    });
  }

  for (const filter of [
    { type: "rewritePath", to: "/new" },
    { kind: "stripPrefix", prefix: "api" },
    { kind: "addPrefix", prefix: "api" },
    { kind: "stripPrefix", prefix: "" },
    { kind: "addPrefix", prefix: "" },
    { kind: "requestHeader", header: "Bad Header", value: "x" },
    { kind: "responseHeader", header: "Bad Header", value: "x" },
    { kind: "requestHeader", name: "X-Header", value: "x" },
    { kind: "redirect", to: "" },
  ]) {
    it(`rejects invalid plan filter ${JSON.stringify(filter)}`, () => {
      // Given invalid plan options.
      // When decoding the filter.
      const result = Schema.decodeUnknownResult(Contracts.RouteFilter)(filter);
      // Then validation fails.
      expect(Result.isFailure(result)).toBe(true);
    });
  }

  it("exports exactly the supported filter type ids", () => {
    // Given the public discriminator schema.
    // When inspecting its literal values.
    const types = Contracts.RouteFilterKind.literals;
    // Then only the five supported ids are available.
    expect(types).toEqual(["stripPrefix", "addPrefix", "requestHeader", "responseHeader", "redirect"]);
  });
});

describe("route input and plans", () => {
  for (const input of [
    "app.lndo.site/api",
    { hostname: "app.lndo.site", filters: [{ kind: "addPrefix", prefix: "/v1" }] },
  ] as const) {
    it(`accepts authored route ${JSON.stringify(input)}`, () => {
      // Given shorthand or object authoring with kind filters.
      // When decoding the public route input.
      const result = Schema.decodeUnknownSync(Contracts.RouteInput)(input);
      // Then the authored form decodes; filters keep the plan kind discriminator.
      if (typeof input === "string") expect(result).toEqual(input);
      else
        expect(result).toEqual({
          hostname: "app.lndo.site",
          filters: [{ kind: "addPrefix", prefix: "/v1" }],
        });
    });
  }

  it("encodes authored route filters back as kind", () => {
    const decoded = Schema.decodeUnknownSync(Contracts.RouteObjectInput, { onExcessProperty: "error" })({
      hostname: "app.lndo.site",
      filters: [
        { kind: "stripPrefix", name: "api", prefix: "/api" },
        { kind: "redirect", to: "/login", permanent: true },
      ],
    });
    expect(Schema.encodeSync(Contracts.RouteObjectInput)(decoded)).toEqual({
      hostname: "app.lndo.site",
      filters: [
        { kind: "stripPrefix", name: "api", prefix: "/api" },
        { kind: "redirect", to: "/login", permanent: true },
      ],
    });
  });

  for (const filter of [
    { type: "addPrefix", prefix: "/v1" },
    { kind: "addPrefix", type: "addPrefix", prefix: "/v1" },
    { kind: "stripPrefix", prefix: "api" },
  ] as const) {
    it(`rejects legacy or invalid authored filter ${JSON.stringify(filter)}`, () => {
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(Contracts.RouteObjectInput, { onExcessProperty: "error" })({
            hostname: "app.lndo.site",
            filters: [filter],
          }),
        ),
      ).toBe(true);
    });
  }

  it("rejects empty route shorthand", () => {
    // Given an empty shorthand.
    // When decoding the public route input.
    const result = Schema.decodeUnknownResult(Contracts.RouteInput)("");
    // Then the shorthand is rejected.
    expect(Result.isFailure(result)).toBe(true);
  });

  for (const options of [{}, { filters: [{ kind: "stripPrefix", prefix: "/api" }] }] as const) {
    it(`accepts a route plan with optional filters ${JSON.stringify(options)}`, () => {
      // Given a complete backend with optional plan filters.
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
      expect(result).toEqual({ ...plan, priority: 2 });
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
