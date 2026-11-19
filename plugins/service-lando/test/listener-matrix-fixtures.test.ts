import { describe, expect, test } from "bun:test";
import { LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";
import { Effect, Exit, Schema } from "effect";

import { serviceTypes } from "../src/index.ts";
import { matrixFixtures } from "./support/listener-matrix-fixtures.ts";

const reasonsOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? String(exit.cause) : "";

/**
 * The catalog type for an authored reference. A versioned family (`postgres:16`)
 * loads its base type; the version only picks the pinned artifact tag.
 */
const catalogServiceType = (reference: string | undefined) =>
  reference === undefined
    ? undefined
    : (serviceTypes.get(reference) ?? serviceTypes.get(reference.slice(0, reference.lastIndexOf(":"))));

describe("listener matrix fixtures are Landofiles the planner accepts", () => {
  for (const fixture of matrixFixtures) {
    test(`${fixture.contract} resolves its authored service`, async () => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "matrix",
        services: { subject: fixture.service },
      });
      const service = landofile.services?.[ServiceName.make("subject")];
      if (service === undefined) throw new Error(`${fixture.contract} service missing from its fixture`);
      const serviceType = catalogServiceType(fixture.service.type);
      if (serviceType === undefined)
        throw new Error(`${fixture.contract} has no catalog service type for ${fixture.service.type}`);

      const exit = await Effect.runPromiseExit(
        serviceType.resolve({
          name: "subject",
          service,
          appName: "matrix",
          appRoot: "/srv/apps/matrix",
          provider: ProviderId.make("lando"),
          primary: false,
          metadata: {
            resolvedAt: "2026-11-16T00:00:00Z",
            source: "@lando/service-lando/test/listener-matrix-fixtures",
            runtime: 4,
          },
          host: {
            os: "linux",
            user: "test",
            uid: "1000",
            gid: "1000",
            home: "/home/test",
            arch: "x64",
          },
        }),
      );

      expect(reasonsOf(exit)).toBe("");
      expect(exit).toMatchObject({ _tag: "Success" });
    });
  }
});
