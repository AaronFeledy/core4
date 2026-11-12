import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineApiClient } from "@lando/container-runtime/engine-api";
import type { ProviderInternalError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  type ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ArtifactBuildSpec, ArtifactRef, RuntimeProviderShape } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Exit, Option } from "effect";

/** Output emitted by the Dockerfile step that fails the build. */
export const BUILD_FAILURE_MARKER = "build-step-output-marker";
export const BUILD_FIRST_MARKER = "first-step-output-marker";
export const BUILD_SECOND_MARKER = "second-step-output-marker";

/** Every marker the suites assert; steps assemble them at run time so no instruction can supply one. */
const ASSERTED_MARKERS = [BUILD_FAILURE_MARKER, BUILD_FIRST_MARKER, BUILD_SECOND_MARKER] as const;

const FAILURE_STEP = `RUN printf 'build-step-%s-marker\\n' output && exit 7`;
const FIRST_STEP = `RUN printf 'first-step-%s-marker\\n' output`;
const SECOND_STEP = `RUN printf 'second-step-%s-marker\\n' output`;

const BASE_IMAGE = "busybox:1.37";
const SERVICE_NAME = ServiceName.make("web");
const PLAN_METADATA = {
  resolvedAt: DateTime.makeUnsafe("2026-11-11T00:00:00Z"),
  source: "container-runtime/build-output-contract",
  runtime: 4 as const,
};

type OutputSink = NonNullable<ArtifactBuildSpec["onOutput"]>;

export interface BuildOutputContractInput {
  readonly provider: RuntimeProviderShape;
  /** Engine API on the same socket, used only to remove the image a build produced. */
  readonly api: EngineApiClient;
  readonly providerId: ProviderId;
  /** Providers compute this from the plan service; it makes each run's image tag unique. */
  readonly buildKeyFor: (service: ServicePlan) => Effect.Effect<string, ProviderInternalError>;
}

type BuildFixture = {
  readonly plan: AppPlan;
  readonly service: ServicePlan;
  readonly remove: () => Promise<void>;
};

const recordingSink =
  (texts: string[]): OutputSink =>
  (text) =>
    Effect.sync(() => {
      texts.push(text);
    });

type SinkDiscipline = {
  active: number;
  maxActive: number;
  calls: number;
  texts: string[];
};

/**
 * Enters, records, yields once, then exits. If the provider started the next
 * call before awaiting this one, `maxActive` would rise above one.
 */
const disciplinedSink =
  (state: SinkDiscipline): OutputSink =>
  (text) =>
    Effect.gen(function* () {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.calls += 1;
      state.texts.push(text);
      yield* Effect.yieldNow;
      state.active -= 1;
    });

const buildFixture = async (
  input: BuildOutputContractInput,
  steps: readonly string[],
): Promise<BuildFixture> => {
  const context = await mkdtemp(join(tmpdir(), "lando-build-output-"));
  const dockerfile = [`FROM ${BASE_IMAGE}`, ...steps, ""].join("\n");
  assert.ok(
    ASSERTED_MARKERS.every((marker) => !dockerfile.includes(marker)),
    "the Dockerfile must not contain an asserted marker; steps must assemble markers at run time",
  );
  await writeFile(join(context, "Dockerfile"), dockerfile);

  const appId = AppId.make(`build-output-${String(input.providerId)}-${crypto.randomUUID()}`);
  // The unique value survives build-key filtering, so parallel runs cannot share an image tag.
  const service: ServicePlan = {
    name: SERVICE_NAME,
    type: "busybox",
    provider: input.providerId,
    primary: true,
    artifact: {
      kind: "build",
      context: AbsolutePath.make(context),
      spec: PortablePath.make("Dockerfile"),
    },
    environment: { BUILD_OUTPUT_RUN: crypto.randomUUID() },
    mounts: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata: PLAN_METADATA,
    extensions: {},
  };
  const plan: AppPlan = {
    id: appId,
    name: "Build Output Contract",
    slug: "build-output-contract",
    root: AbsolutePath.make(context),
    provider: input.providerId,
    services: { [SERVICE_NAME]: service },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: PLAN_METADATA,
    extensions: {},
  };

  return {
    plan,
    service,
    remove: () => rm(context, { recursive: true, force: true }),
  };
};

const removeBuiltImage = async (input: BuildOutputContractInput, artifact: ArtifactRef): Promise<void> => {
  const request = input.api.request;
  assert.ok(request !== undefined, "the live engine client must expose request for image cleanup");
  const response = await Effect.runPromise(
    request({ method: "DELETE", path: `/images/${encodeURIComponent(artifact.ref)}?force=true` }),
  );
  assert.ok(
    response.status >= 200 && response.status < 300,
    `removing built image ${artifact.ref} failed with HTTP ${response.status}: ${response.body}`,
  );
};

/**
 * A failing step's output must reach the sink while the build is still running,
 * and the build must fail with `ArtifactBuildError` rather than replaying a
 * buffered transcript after the fact.
 */
export const assertFailedBuildDeliversOutput = async (input: BuildOutputContractInput): Promise<void> => {
  const fixture = await buildFixture(input, [FAILURE_STEP]);
  try {
    const texts: string[] = [];
    const buildKey = await Effect.runPromise(input.buildKeyFor(fixture.service));
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          input.provider.buildArtifact({
            app: fixture.plan.id,
            service: fixture.service.name,
            plan: fixture.plan,
            buildKey,
            onOutput: recordingSink(texts),
          }),
        ),
      ),
    );

    assert.equal(Exit.isFailure(exit), true, "a step exiting 7 must fail the build");
    if (!Exit.isFailure(exit)) return;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (failure === undefined || failure._tag !== "ArtifactBuildError") {
      assert.fail(`expected ArtifactBuildError, received ${failure?._tag ?? "no typed failure"}`);
    }
    assert.equal(failure.providerId, input.providerId);
    // The sink ran to completion before the effect settled, so this text crossed the sink pre-failure.
    assert.ok(
      texts.join("").includes(BUILD_FAILURE_MARKER),
      `build output did not reach the sink: ${JSON.stringify(texts)}`,
    );
  } finally {
    await fixture.remove();
  }
};

/** A passing build must deliver both step outputs in step order and return a removable artifact. */
export const assertPassingBuildDeliversOutputInOrder = async (
  input: BuildOutputContractInput,
): Promise<void> => {
  const fixture = await buildFixture(input, [FIRST_STEP, SECOND_STEP]);
  const texts: string[] = [];
  try {
    const buildKey = await Effect.runPromise(input.buildKeyFor(fixture.service));
    const artifact = await Effect.runPromise(
      Effect.scoped(
        input.provider.buildArtifact({
          app: fixture.plan.id,
          service: fixture.service.name,
          plan: fixture.plan,
          buildKey,
          onOutput: recordingSink(texts),
        }),
      ),
    );
    try {
      assert.ok(artifact.ref.length > 0, "a passing build must return a non-empty artifact ref");
      assert.equal(artifact.providerId, input.providerId);
      const output = texts.join("");
      const first = output.indexOf(BUILD_FIRST_MARKER);
      const second = output.indexOf(BUILD_SECOND_MARKER);
      assert.ok(first >= 0, `first step output missing: ${JSON.stringify(texts)}`);
      assert.ok(second >= 0, `second step output missing: ${JSON.stringify(texts)}`);
      assert.ok(first < second, "build output arrived out of step order");
    } finally {
      await removeBuiltImage(input, artifact);
    }
  } finally {
    await fixture.remove();
  }
};

/** The provider must await each sink call before starting the next one. */
export const assertBuildOutputSinkDoesNotOverlap = async (input: BuildOutputContractInput): Promise<void> => {
  const fixture = await buildFixture(input, [FIRST_STEP, SECOND_STEP]);
  const state: SinkDiscipline = { active: 0, maxActive: 0, calls: 0, texts: [] };
  try {
    const buildKey = await Effect.runPromise(input.buildKeyFor(fixture.service));
    const artifact = await Effect.runPromise(
      Effect.scoped(
        input.provider.buildArtifact({
          app: fixture.plan.id,
          service: fixture.service.name,
          plan: fixture.plan,
          buildKey,
          onOutput: disciplinedSink(state),
        }),
      ),
    );
    try {
      // Two step markers guarantee at least two calls, so an overlap would have been observable.
      assert.ok(state.calls >= 2, `expected at least two sink calls, received ${state.calls}`);
      assert.equal(state.active, 0, "every sink call must have exited before the build settled");
      assert.equal(state.maxActive, 1, "the provider entered a sink call while another was still open");
    } finally {
      await removeBuiltImage(input, artifact);
    }
  } finally {
    await fixture.remove();
  }
};
