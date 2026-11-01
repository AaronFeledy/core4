import { expect } from "bun:test";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { exec, logs } from "@lando/provider-lando";
import { runProbe } from "@lando/sdk/probe";
import { LogSourceId } from "@lando/sdk/schema";
import { Duration, Effect, Schema, Stream } from "effect";
import { PhpAcceptanceError, type PhpEvidence, digest } from "./php-ownership-evidence.ts";
import { type PhpStack, web } from "./php-ownership-stack.ts";

export const execute = (stack: PhpStack, command: readonly string[]) =>
  exec(stack.plan, { app: stack.plan.id, service: web }, { command: [...command] }, { api: stack.api }).pipe(
    Effect.timeout("10 seconds"),
  );

// Real HTTP over container loopback: no reserved host ports, routing service or host CLI needed.
const httpClient = `$ctx = stream_context_create(['http' => ['timeout' => 3, 'ignore_errors' => true]]);
$body = file_get_contents('http://127.0.0.1:8080/' . $argv[1], false, $ctx);
if ($body === false) { exit(1); }
$headers = $http_response_header;
preg_match('/^HTTP\\/\\S+ (\\d+)/', $headers[0], $status);
$uid = null;
foreach ($headers as $header) { if (preg_match('/^X-Effective-Uid: (\\d+)/i', $header, $match)) { $uid = (int)$match[1]; } }
echo json_encode(['status' => (int)$status[1], 'body' => $body, 'uid' => $uid], JSON_THROW_ON_ERROR);`;
const HttpObservation = Schema.Struct({ status: Schema.Int, body: Schema.String, uid: Schema.Int });

export const requestPhp = Effect.fn("PhpAcceptance.http")(function* (stack: PhpStack, query = "") {
  const response = yield* execute(stack, ["php", "-r", httpClient, query]);
  if (response.exitCode !== 0)
    return yield* Effect.fail(new PhpAcceptanceError({ phase: "http", message: "HTTP client failed" }));
  return yield* Schema.decodeUnknownEffect(HttpObservation)(JSON.parse(response.stdout));
});

export const waitForPhp = Effect.fn("PhpAcceptance.ready")(function* (stack: PhpStack) {
  const readiness = yield* runProbe(
    {
      id: "php-http",
      policy: { maxAttempts: 60, delay: Duration.seconds(1), timeout: Duration.seconds(90) },
    },
    requestPhp(stack).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.fail(new PhpAcceptanceError({ phase: "http", message: `HTTP ${response.status}` })),
      ),
    ),
  );
  // Bounded, non-secret diagnostics: no raw provider info or unredacted logs in receipts.
  expect(readiness.outcome, `HTTP readiness: ${readiness.attempts} attempts, ${readiness.elapsedMs}ms`).toBe(
    "green",
  );
  return readiness;
});

export const assertHttp = (observed: Schema.Schema.Type<typeof HttpObservation>, sapi: string) => {
  expect(observed.status).toBe(200);
  expect(observed.body).toBe(`php-ownership:${sapi}`);
  return { httpStatus: observed.status, httpBodySha256: digest(observed.body), effectiveUid: observed.uid };
};

export const readLogs = (stack: PhpStack, source?: "access" | "error") =>
  logs(
    stack.plan,
    { app: stack.plan.id, service: web },
    {
      follow: false,
      tail: 200,
      ...(source === undefined ? {} : { source: LogSourceId.make(source) }),
    },
    { api: stack.api },
  ).pipe(Stream.take(400), Stream.runCollect, Effect.timeout("10 seconds"));

export const assertMarkerLogs = Effect.fn("PhpAcceptance.logs")(function* (stack: PhpStack, marker: string) {
  // Retry observations, NEVER the marker request. Apache's piped logger may flush after HTTP completes.
  const flushed = yield* runProbe(
    {
      id: "php-log-flush",
      policy: { maxAttempts: 20, delay: Duration.millis(250), timeout: Duration.seconds(15) },
    },
    readLogs(stack).pipe(
      Effect.flatMap((chunks) =>
        chunks.some((chunk) => chunk.line.includes(`?marker=${marker}`)) &&
        chunks.some((chunk) => chunk.line.includes(`php-error-${marker}`))
          ? Effect.void
          : Effect.fail(new PhpAcceptanceError({ phase: "logs", message: "Marker logs not yet flushed" })),
      ),
    ),
  );
  expect(flushed.outcome).toBe("green");
  const chunks = yield* readLogs(stack);
  const access = chunks.filter((chunk) => chunk.line.includes(`?marker=${marker}`));
  const errors = chunks.filter((chunk) => chunk.line.includes(`php-error-${marker}`));
  expect(access).toHaveLength(1);
  expect(access.map((chunk) => chunk.stream)).toEqual(["stdout"]);
  expect(errors).toHaveLength(1);
  expect(errors.map((chunk) => chunk.stream)).toEqual(["stderr"]);
  const accessAlias = yield* readLogs(stack, "access");
  const errorAlias = yield* readLogs(stack, "error");
  expect(accessAlias.length).toBeGreaterThan(0);
  expect(errorAlias.length).toBeGreaterThan(0);
  expect(accessAlias.every((chunk) => chunk.stream === "stdout" && chunk.source === "access")).toBe(true);
  expect(errorAlias.every((chunk) => chunk.stream === "stderr" && chunk.source === "error")).toBe(true);
  expect(accessAlias.filter((chunk) => chunk.line.includes(`?marker=${marker}`))).toHaveLength(1);
  expect(errorAlias.filter((chunk) => chunk.line.includes(`php-error-${marker}`))).toHaveLength(1);
  return {
    accessRecords: access.length,
    errorRecords: errors.length,
    accessPipe: access[0]?.stream ?? "",
    errorPipe: errors[0]?.stream ?? "",
    accessSource: accessAlias[0]?.source ?? "",
    errorSource: errorAlias[0]?.source ?? "",
  };
});

export const recordRuntime = Effect.fn("PhpAcceptance.identity")(function* (
  stack: PhpStack,
  evidence: PhpEvidence,
) {
  const request = stack.api.request;
  if (request === undefined)
    return yield* Effect.fail(new PhpAcceptanceError({ phase: "inspect", message: "HTTP API unavailable" }));
  const version = yield* request({ method: "GET", path: "/version", signal: AbortSignal.timeout(5_000) });
  expect(version.status).toBe(200);
  const runtime = Schema.decodeUnknownSync(
    Schema.Struct({ Version: Schema.String, Os: Schema.String, Arch: Schema.String }),
  )(JSON.parse(version.body));
  const inspect = yield* request({
    method: "GET",
    path: `/containers/${encodeURIComponent(serviceContainerName(stack.plan, web))}/json`,
    signal: AbortSignal.timeout(5_000),
  });
  expect(inspect.status).toBe(200);
  const container = Schema.decodeUnknownSync(
    Schema.Struct({ Image: Schema.String, Config: Schema.Struct({ Cmd: Schema.Array(Schema.String) }) }),
  )(JSON.parse(inspect.body));
  expect(container.Image.length).toBeGreaterThan(0);
  const image = yield* request({
    method: "GET",
    path: `/images/${encodeURIComponent(String(evidence.facts.builtRef))}/json`,
    signal: AbortSignal.timeout(5_000),
  });
  expect(image.status).toBe(200);
  const built = Schema.decodeUnknownSync(Schema.Struct({ Id: Schema.String }))(JSON.parse(image.body));
  expect(container.Image.replace(/^sha256:/u, "")).toBe(built.Id.replace(/^sha256:/u, ""));
  Object.assign(evidence.facts, {
    runtimeVersion: runtime.Version,
    os: runtime.Os,
    arch: runtime.Arch,
    imageId: container.Image,
  });
  return container;
});
