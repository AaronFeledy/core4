import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeDiagnosticTail, makeDiagnosticTailFactory } from "../src/diagnostic-tail.ts";
import { RedactionService } from "../src/service.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

test("redacts split UTF-8 and exact tokens before retaining a diagnostic tail", async () => {
  const tail = await Effect.runPromise(
    makeDiagnosticTail({ PGPASSWORD: "sëcret-token", MYSQL_PWD: "lando", SQLCMDPASSWORD: "x" }),
  );
  const input = bytes("é failure sëcret-token lando\npassword=private-value\nlast line");
  for (const byte of input) tail.write(new Uint8Array([byte]));
  const result = tail.finish();
  expect(result).toContain("é failure");
  expect(result).toContain("last line");
  expect(result).not.toContain("sëcret-token");
  expect(result).not.toContain("lando");
  expect(result).not.toContain("private-value");
});

test("suppresses a short authoritative secret rather than publishing its line", async () => {
  const tail = await Effect.runPromise(makeDiagnosticTail({ SQLCMDPASSWORD: "x" }));
  tail.write(bytes("context x\nclean\n"));
  expect(tail.finish()).not.toContain("context x");
});

test("bounds retained output and drops oversized unfinished lines", async () => {
  const tail = await Effect.runPromise(makeDiagnosticTail({ TOKEN: "boundary-secret" }));
  tail.write(bytes("old diagnostic\n".repeat(2000)));
  tail.write(bytes(`${"z".repeat(100000)}boundary-secret`));
  const result = tail.finish() ?? "";
  expect(bytes(result).length).toBeLessThanOrEqual(8192);
  expect(result).toContain("[diagnostic truncated]");
  expect(result).not.toContain("boundary-secret");
  expect(result).not.toContain("zzzz");
});

test("keeps concurrent collectors independent and recovers after an oversized line", async () => {
  const [first, second] = await Effect.runPromise(Effect.all([makeDiagnosticTail(), makeDiagnosticTail()]));
  first.write(bytes(`${"x".repeat(9000)}\nfirst\n`));
  second.write(bytes("second"));
  expect(first.finish()).toBe("[diagnostic truncated]\nfirst\n");
  expect(second.finish()).toBe("second");
});

test("redacts URI passwords and tokens before a UTF-8 tail boundary is cut", async () => {
  const tail = await Effect.runPromise(
    makeDiagnosticTail({ MONGO_URI: "mongodb://user:lando@localhost/app" }),
  );
  tail.write(bytes(`failed lando\n${"é".repeat(4080)}\n`));
  const result = tail.finish() ?? "";
  expect(result).not.toContain("lando");
  expect(result).not.toContain("�");
  expect(bytes(result).length).toBeLessThanOrEqual(8192);
});

test("isolates factory collectors while resolving the live redactor only once", async () => {
  // Given a real redaction service with counted profile and payload resolution.
  let profiles = 0;
  let payloads = 0;
  const results = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* RedactionService;
      const createTail = yield* makeDiagnosticTailFactory({ MYSQL_PWD: "command-secret" }).pipe(
        Effect.provideService(RedactionService, {
          ...service,
          forProfile: (profile, options) =>
            Effect.tap(service.forProfile(profile, options), () =>
              Effect.sync(() => {
                profiles += 1;
              }),
            ),
          payloadValues: (options) =>
            Effect.tap(service.payloadValues(options), () =>
              Effect.sync(() => {
                payloads += 1;
              }),
            ),
        }),
      );
      // When independent collectors interleave, finish, and see a later registered secret.
      const first = createTail();
      const second = createTail();
      first.write(bytes("first command-"));
      second.write(bytes("second command-secret"));
      const secondResult = second.finish();
      first.write(bytes("secret"));
      const firstResult = first.finish();
      yield* service.registerValues(["registered-later"]);
      const third = createTail();
      third.write(bytes("third registered-later command-secret"));
      return [firstResult, secondResult, third.finish()];
    }).pipe(Effect.provide(RedactionService.layer)),
  );
  // Then no decoder, exact-match buffer, or finished state leaks between collectors.
  expect(results).toEqual(["first [redacted]", "second [redacted]", "third [redacted] [redacted]"]);
  expect(profiles).toBe(1);
  expect(payloads).toBe(1);
});
