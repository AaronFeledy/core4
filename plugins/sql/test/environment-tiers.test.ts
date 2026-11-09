import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { PortNumber } from "@lando/sdk/schema";
import { Effect } from "effect";
import { SqlEnvironmentSession, registerSqlCredentials } from "../src/environment.ts";
import type { SqlPlan } from "../src/views.ts";

test.each(["lando", "wp"])(
  "resolved credential %s remains substring even when its bytes are public",
  async (resolved) => {
    const password = { _tag: "SecretRef", reference: "PASSWORD" } as const;
    const plan: SqlPlan = {
      id: "sql",
      name: "sql",
      root: "/tmp/sql",
      services: {
        db: {
          name: "db",
          type: "mysql",
          environment: {},
          extensions: {},
          mounts: [],
          storage: [],
          connection: {
            family: "mysql",
            port: PortNumber.make(3306),
            creds: { user: "wp", database: "wp", password },
          },
        },
      },
    };
    const redaction = makeRedactionService();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registered = yield* registerSqlCredentials(plan, [password]);
        const redactor = yield* redaction.forProfile("secrets");
        return { text: redactor.redactString(`${resolved}-seo`), tokens: registered.substringTokens };
      }).pipe(
        Effect.provideService(RedactionService, redaction),
        Effect.provideService(SqlEnvironmentSession, {
          resolveEnvironment: (env) =>
            Effect.succeed(Object.fromEntries(Object.keys(env).map((key) => [key, resolved]))),
        }),
      ),
    );
    expect(result).toEqual({ text: "[redacted]-seo", tokens: [resolved] });
  },
);
