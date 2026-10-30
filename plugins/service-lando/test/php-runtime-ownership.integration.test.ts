import { expect, test } from "bun:test";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { postServiceLifecycle } from "@lando/provider-lando";
import { Effect } from "effect";
import { PhpAcceptanceError, type PhpEvidence, recordPhpJourney } from "./support/php-ownership-evidence.ts";
import {
  assertHttp,
  assertMarkerLogs,
  execute,
  recordRuntime,
  requestPhp,
  waitForPhp,
} from "./support/php-ownership-observations.ts";
import {
  acquirePhpStack,
  buildSteps,
  canonicalBase,
  requireWeb,
  web,
} from "./support/php-ownership-stack.ts";

const socket = resolveLiveProviderSocket();
if (socket === undefined && process.env.LANDO_GUIDE_E2E === "1") {
  throw new PhpAcceptanceError({
    phase: "opt-in",
    message: "LANDO_TEST_PODMAN_SOCKET must name an answering socket",
  });
}
const liveTest = test.skipIf(socket === undefined);
const socketPath = () => {
  if (socket === undefined)
    throw new PhpAcceptanceError({ phase: "opt-in", message: "Live socket required" });
  return socket.socketPath;
};
const evidenceFor = (scenario: string): PhpEvidence => ({
  id: `php-own-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
  scenario,
  phase: "fixture",
  cleanup: "not-acquired",
  facts: {},
});

liveTest(
  "serves non-root Apache with persisted home, native log aliases and stop/start",
  async () => {
    // Given: default home persistence, no authored startup or log redirection workarounds.
    const evidence = evidenceFor("nonroot-apache");
    const marker = crypto.randomUUID();
    await recordPhpJourney(
      evidence,
      Effect.scoped(
        Effect.gen(function* () {
          // When: the actual planner, derived build and provider start the authored service.
          const stack = yield* acquirePhpStack(socketPath(), { service: { user: "www-data" } }, evidence);
          const planned = requireWeb(stack.authoredPlan);
          // Then: home preparation survived the complete build and HTTP runs as the planned non-root user.
          expect(planned.home).toMatchObject({ state: "persisted", user: "www-data", target: "/var/www" });
          expect(buildSteps(planned).map((step) => step.id)).toContain("service-lando.php:prerequisites");
          expect(planned.command).toBeDefined();
          expect(planned.logSources).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "access", strategy: "console", stream: "stdout" }),
              expect.objectContaining({ id: "error", strategy: "console", stream: "stderr" }),
            ]),
          );
          const runtime = yield* recordRuntime(stack, evidence);
          expect(requireWeb(stack.plan).artifact).not.toEqual(planned.artifact);
          expect(planned.command).toEqual(runtime.Config.Cmd);
          const readiness = yield* waitForPhp(stack);
          evidence.phase = "http-and-logs";
          const observed = yield* requestPhp(stack, `?marker=${marker}`);
          const http = assertHttp(observed, "apache2handler");
          expect(observed.uid).toBeGreaterThan(0);
          const identity = yield* execute(stack, ["id", "-u"]);
          expect(identity.exitCode).toBe(0);
          expect(Number(identity.stdout.trim())).toBe(observed.uid);
          Object.assign(
            evidence.facts,
            http,
            { readinessAttempts: readiness.attempts },
            yield* assertMarkerLogs(stack, marker),
          );
          const homeWrite = yield* execute(stack, [
            "sh",
            "-c",
            'test "$HOME" = /var/www && printf %s "$1" > "$HOME/.php-ownership"',
            "sh",
            marker,
          ]);
          expect(homeWrite.exitCode).toBe(0);
          evidence.phase = "stop-start";
          yield* postServiceLifecycle(stack.plan, { app: stack.plan.id, service: web }, "stop", {
            api: stack.api,
          });
          yield* postServiceLifecycle(stack.plan, { app: stack.plan.id, service: web }, "start", {
            api: stack.api,
          });
          yield* waitForPhp(stack);
          const restarted = yield* requestPhp(stack);
          assertHttp(restarted, "apache2handler");
          expect(restarted.uid).toBe(observed.uid);
          const homeRead = yield* execute(stack, [
            "sh",
            "-c",
            'test "$(cat "$HOME/.php-ownership")" = "$1"',
            "sh",
            marker,
          ]);
          expect(homeRead.exitCode).toBe(0);
          Object.assign(evidence.facts, {
            restartHttpStatus: restarted.status,
            homeWriteExit: homeWrite.exitCode,
            homeRetainedExit: homeRead.exitCode,
          });
          evidence.phase = "cleanup";
        }).pipe(Effect.timeout("10 minutes")),
      ),
    );
  },
  720_000,
);

liveTest(
  "honors contextual Dockerfile CMD without implicit PHP setup or launcher",
  async () => {
    // Given: the same canonical PHP minor, with only the Dockerfile owning the process.
    const evidence = evidenceFor("contextual-cmd");
    const cmd = ["php", "-S", "0.0.0.0:8080", "-t", "/app"];
    await recordPhpJourney(
      evidence,
      Effect.scoped(
        Effect.gen(function* () {
          // When
          const stack = yield* acquirePhpStack(
            socketPath(),
            {
              service: { build: { context: ".", dockerfile: "Dockerfile" } },
              dockerfile: `FROM ${canonicalBase}\nCMD ${JSON.stringify(cmd)}\n`,
            },
            evidence,
          );
          // Then: final planner output retains the context; the running image, not Apache, owns CMD.
          const planned = requireWeb(stack.authoredPlan);
          expect(planned.artifact).toMatchObject({
            kind: "build",
            context: stack.authoredPlan.root,
            spec: "Dockerfile",
          });
          expect(planned.command).toBeUndefined();
          expect(planned.entrypoint).toBeUndefined();
          expect(planned.logSources ?? []).toEqual([]);
          const ids = buildSteps(planned).map((step) => step.id);
          const implicitSteps = ids.filter(
            (id) => id.startsWith("service-lando.php:") || id.startsWith("lando-log-redirect"),
          );
          expect(implicitSteps).toEqual([]);
          const container = yield* recordRuntime(stack, evidence);
          expect(container.Config.Cmd).toEqual(cmd);
          yield* waitForPhp(stack);
          const observed = yield* requestPhp(stack);
          Object.assign(evidence.facts, assertHttp(observed, "cli-server"), {
            imageCmd: container.Config.Cmd,
            implicitPhpSteps: implicitSteps.length,
            implicitLogs: (planned.logSources ?? []).length,
          });
          evidence.phase = "cleanup";
        }).pipe(Effect.timeout("10 minutes")),
      ),
    );
  },
  720_000,
);

liveTest(
  "keeps stock PHP startup when an additive artifact script creates a marker",
  async () => {
    // Given: additive build intent, not a replacement context or an authored process.
    const evidence = evidenceFor("additive-artifact");
    await recordPhpJourney(
      evidence,
      Effect.scoped(
        Effect.gen(function* () {
          // When
          const stack = yield* acquirePhpStack(
            socketPath(),
            { service: { build: { artifact: ["touch /usr/local/share/php-ownership-artifact"] } } },
            evidence,
          );
          // Then: both stock setup and the additive script were built, and stock Apache actually serves.
          const planned = requireWeb(stack.authoredPlan);
          expect(planned.artifact).toMatchObject({ kind: "ref" });
          expect(buildSteps(planned).map((step) => step.id)).toEqual(
            expect.arrayContaining(["service-lando.php:prerequisites", "authored-artifact:1"]),
          );
          expect(planned.command).toBeDefined();
          const runtime = yield* recordRuntime(stack, evidence);
          expect(planned.command).toEqual(runtime.Config.Cmd);
          yield* waitForPhp(stack);
          const observed = yield* requestPhp(stack);
          const marker = yield* execute(stack, ["test", "-f", "/usr/local/share/php-ownership-artifact"]);
          expect(marker.exitCode).toBe(0);
          Object.assign(evidence.facts, assertHttp(observed, "apache2handler"), {
            artifactMarkerExit: marker.exitCode,
          });
          evidence.phase = "cleanup";
        }).pipe(Effect.timeout("10 minutes")),
      ),
    );
  },
  720_000,
);
