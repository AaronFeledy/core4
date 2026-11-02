import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { Effect, Stream } from "effect";
import { checkedSqlExecution } from "../src/checked-execution.ts";
import { SqlEnvironmentSession } from "../src/environment.ts";
import { valueResolver } from "./support/value-resolver.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("checkedSqlExecution never treats env Object.values as authoritative secrets", async () => {
  const publicPath = "lando";
  const values = valueResolver({});
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* values.resolver.openSession();
      const result = yield* checkedSqlExecution(
        Stream.make(
          { kind: "stderr" as const, chunk: bytes(`/tmp/${publicPath}-pc-qa/dump failed\n`) },
          { exitCode: 1 },
        ),
        {
          service: "database",
          command: ["mysql"],
          env: { MYSQL_PWD: publicPath, MYSQL_USER: "lando", MYSQL_DATABASE: "lando" },
          // Explicit empty secrets: env values must not be scraped.
          secrets: { substring: [], wholeToken: [] },
        },
      ).pipe(Effect.provideService(SqlEnvironmentSession, session), Effect.result);
      if (result._tag !== "Failure") throw new Error("expected failure");
      if (result.failure._tag !== "SqlCommandFailedError") throw result.failure;
      expect(result.failure).toMatchObject({ _tag: "SqlCommandFailedError" });
      expect(result.failure.stderrTail).toContain(publicPath);
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
});

test("checkedSqlExecution whole-token secrets do not substring-mask compound paths", async () => {
  const password = "wordpress";
  const values = valueResolver({});
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* values.resolver.openSession();
      const redaction = yield* RedactionService;
      const result = yield* checkedSqlExecution(
        Stream.make(
          {
            kind: "stderr" as const,
            chunk: bytes(`${password} path=wp-content/plugins/wordpress-seo\n`),
          },
          { exitCode: 1 },
        ),
        {
          service: "database",
          command: ["mysql"],
          env: { MYSQL_PWD: password },
          secrets: { substring: [], wholeToken: [password] },
        },
      ).pipe(Effect.provideService(SqlEnvironmentSession, session), Effect.result);
      if (result._tag !== "Failure") throw new Error("expected failure");
      if (result.failure._tag !== "SqlCommandFailedError") throw result.failure;
      expect(result.failure.stderrTail).toBe("[redacted] path=wp-content/plugins/wordpress-seo\n");
      const redactor = yield* redaction.forProfile("secrets");
      expect(redactor.redactString("wp-content/plugins/wordpress-seo")).toBe(
        "wp-content/plugins/wordpress-seo",
      );
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
});

test("checkedSqlExecution substring secrets mask every occurrence", async () => {
  const password = "private-app-secret";
  const values = valueResolver({});
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* values.resolver.openSession();
      const result = yield* checkedSqlExecution(
        Stream.make(
          {
            kind: "stderr" as const,
            chunk: bytes(`fail ${password} and again-${password}-tail\n`),
          },
          { exitCode: 1 },
        ),
        {
          service: "database",
          command: ["mysql"],
          env: { MYSQL_PWD: password },
          secrets: { substring: [password], wholeToken: [] },
        },
      ).pipe(Effect.provideService(SqlEnvironmentSession, session), Effect.result);
      if (result._tag !== "Failure") throw new Error("expected failure");
      if (result.failure._tag !== "SqlCommandFailedError") throw result.failure;
      expect(result.failure.stderrTail).not.toContain(password);
      expect(result.failure.stderrTail).toContain("[redacted]");
    }).pipe(Effect.provide(RedactionService.layer), Effect.scoped),
  );
});
