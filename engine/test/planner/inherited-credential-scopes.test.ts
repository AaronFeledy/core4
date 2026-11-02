import { expect, test } from "bun:test";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { connectionClientsForPlan, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { invocationToolingForPlan, sitesUnder } from "../../src/planner/invocation-authority.ts";
import { materializeLandofileScopesForPlan } from "../../src/planner/landofile-scopes.ts";
import { resolveToolingTaskShape } from "../../src/tooling/step-runner.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planInherited } from "./inherited-service-fixture.ts";

const root = process.cwd();
const cases = [
  {
    parent: "redis",
    options: { password: "${secret:INHERITED}" },
    native: "REDISCLI_AUTH",
    client: "redis-cli",
    clientEnv: "REDISCLI_AUTH",
  },
  {
    parent: "postgres",
    options: { creds: { user: "inherited", database: "inherited", password: "${secret:INHERITED}" } },
    native: "POSTGRES_PASSWORD",
    client: "psql",
    clientEnv: "PGPASSWORD",
  },
] as const;

test.each([...cases])(
  "inherits real $parent credentials before cross-service evaluation and feature composition",
  async ({ parent, options, native, client, clientEnv }) => {
    const { plan } = await Effect.runPromise(planInherited(parent, options, true));
    const password = { _tag: "SecretRef", reference: "INHERITED" } as const;
    expect(plan.services[ServiceName.make("web")]?.environment.PASSWORD).toEqual(password);
    expect(plan.services[ServiceName.make("database")]?.environment[native]).toEqual(password);
    expect(effectiveToolingForPlan(plan)?.[client]?.env?.[clientEnv]).toEqual(password);
    expect(connectionClientsForPlan(plan)).toEqual(
      parent === "postgres" ? { psql: ServiceName.make("database") } : {},
    );
  },
);

test.each([...cases])(
  "retains real inherited $parent facts through strict AppPlan JSON and invocation scopes",
  async ({ parent, options }) => {
    const { plan } = await Effect.runPromise(planInherited(parent, options));
    const persisted = Schema.decodeUnknownSync(AppPlan)(
      JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(plan))),
      { onExcessProperty: "error" },
    );
    const invocation = await Effect.runPromise(
      compileTestLandofile(
        {
          name: "inherited-creds",
          tooling: {
            check: {
              cmd: "echo",
              env: { PASSWORD: "{{ event.use ? services.database.creds.password : 'unused' }}" },
            },
          },
        },
        root,
      ),
    );
    const task = await Effect.runPromise(
      Effect.gen(function* () {
        const compiled = yield* materializeLandofileScopesForPlan(
          {
            landofile: invocation,
            appRoot: root,
            landofilePath: `${root}/.lando.yml`,
            globalConfig: undefined,
          },
          persisted,
        );
        const effective = yield* invocationToolingForPlan(compiled, persisted, "lndo.site");
        const check = effective.tooling.check;
        if (check === undefined) return yield* Effect.die("Missing check task");
        return yield* resolveToolingTaskShape(
          check,
          { event: { use: true } },
          sitesUnder(effective.sites, ["tooling", "check"]),
        );
      }),
    );
    expect(task.env?.PASSWORD).toEqual({ _tag: "SecretRef", reference: "INHERITED" });
  },
);
