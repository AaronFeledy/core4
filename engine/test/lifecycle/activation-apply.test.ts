import { expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { CaError } from "@lando/sdk/errors";
import { type AppPlan, ServiceName, type VolumeIdentity } from "@lando/sdk/schema";
import { EnvironmentValueResolver, StateStore } from "@lando/sdk/services";
import { TEST_CERTIFICATES, TestRuntimeProvider } from "@lando/sdk/test";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect } from "effect";
import { applyActivation } from "../../src/lifecycle/activation-apply.ts";
import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import {
  prepareServiceCertificates,
  stampPreparedCertificates,
} from "../../src/lifecycle/service-certificates.ts";
import { prepareProvider } from "../../src/providers/prepared.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { refusalCases, resolvingProvider, session, unusedResolver } from "./activation-apply-support.ts";
import {
  basePlan,
  leafBind,
  planWithCertificate,
  service,
  withHarness,
} from "./service-certificates-support.ts";

test("activation stamps both prepared binds without changing recorded or completion plans", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir);
    const { certificates } = await Effect.runPromise(harness.run(plan));
    const applied: AppPlan[] = [];
    const recordedPlan = { ...plan, name: "recorded" };
    const completionPlan = { ...plan, name: "completion" };
    const forwarded: (AppPlan | undefined)[] = [];
    const provider = await Effect.runPromise(
      prepareProvider({
        ...TestRuntimeProvider,
        apply: (plan, options) =>
          Effect.sync(() => {
            applied.push(plan);
            forwarded.push(options.recordedPlan, options.completionPlan);
            return { changed: true };
          }),
      }),
    );

    await Effect.runPromise(
      applyActivation({
        provider,
        plan,
        certificates,
        reconcile: false,
        environment: session,
        recordedPlan,
        completionPlan,
      }).pipe(Effect.provideService(EnvironmentValueResolver, unusedResolver)),
    );

    const identity = sha256Hex(TEST_CERTIFICATES.service.certificate);
    expect(
      applied[0]?.services[ServiceName.make("web")]?.mounts.map((mount) =>
        mount.type === "bind" ? mount.sourceIdentity : undefined,
      ),
    ).toEqual([identity, identity]);
    expect(applied[0]?.services[ServiceName.make("custom")]).toBe(plan.services[ServiceName.make("custom")]);
    expect(forwarded[0]).toBe(recordedPlan);
    expect(forwarded[1]).toBe(completionPlan);
  });
});

test.each(refusalCases)(
  "activation refuses a mismatched $name before sessions, callbacks, or apply",
  async ({ change }) => {
    await withHarness(async (harness) => {
      const { plan } = planWithCertificate(harness.certsDir);
      const { certificates } = await Effect.runPromise(harness.run(plan));
      const calls: string[] = [];
      const provider = await Effect.runPromise(
        prepareProvider({
          ...TestRuntimeProvider,
          apply: () =>
            Effect.sync(() => {
              calls.push("apply");
              return { changed: true };
            }),
        }),
      );

      const error = await Effect.runPromise(
        applyActivation({
          provider,
          plan: change(plan),
          certificates,
          reconcile: false,
          beforeApply: Effect.sync(() => void calls.push("before")),
        }).pipe(
          Effect.provideService(EnvironmentValueResolver, {
            openSession: () =>
              Effect.sync(() => {
                calls.push("open");
                return session;
              }),
          }),
          Effect.flip,
        ),
      );

      expect(error._tag).toBe("CaError");
      expect(calls).toEqual([]);
    });
  },
);

test("certificate proof accepts a subset and SAN sets with different order and duplicate entries", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir);
    const web = plan.services[ServiceName.make("web")];
    if (web?.certs === undefined) throw new TypeError("Missing fixture request");
    const api = serviceCertificatePaths(harness.certsDir, routeOwnerFromPlan(plan).ownerKey, "api");
    const prepared = await Effect.runPromise(
      harness.run({
        ...plan,
        services: {
          ...plan.services,
          [ServiceName.make("api")]: {
            ...service("api"),
            certs: web.certs,
            mounts: [leafBind(api.certPath, "/api.crt"), leafBind(api.keyPath, "/api.key")],
          },
        },
      }),
    );
    const preparedWeb = prepared.plan.services[web.name];
    if (preparedWeb === undefined) throw new TypeError("Missing prepared fixture service");
    const selected = {
      ...prepared.plan,
      services: {
        [web.name]: {
          ...preparedWeb,
          certs: { ...web.certs, sans: [...web.certs.sans].reverse().concat(web.certs.sans) },
        },
      },
    };

    const stamped = await Effect.runPromise(stampPreparedCertificates(selected, prepared.certificates));

    expect(stamped).toEqual(selected);
  });
});

test("activation opens and closes a lazy session around admission and provider apply", async () => {
  const plan = basePlan([
    { ...service("web"), environment: { TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" } } },
  ]);
  const { certificates } = await Effect.runPromise(prepareServiceCertificates(plan));
  const calls: string[] = [];
  let environment: Readonly<Record<string, string>> | undefined;
  const resolver = EnvironmentValueResolver.of({
    openSession: () =>
      Effect.gen(function* () {
        calls.push("open");
        yield* Effect.addFinalizer(() => Effect.sync(() => void calls.push("close")));
        return {
          resolveEnvironment: () =>
            Effect.sync(() => {
              calls.push("resolve");
              return { TOKEN: "resolved" };
            }),
        };
      }),
  });
  const provider = await Effect.runPromise(
    resolvingProvider(calls, (value) => {
      environment = value;
    }),
  );

  await Effect.runPromise(
    applyActivation({
      provider,
      plan,
      certificates,
      reconcile: false,
      beforeApply: Effect.sync(() => void calls.push("before")),
    }).pipe(Effect.provideService(EnvironmentValueResolver, resolver)),
  );

  expect(calls).toEqual(["open", "before", "apply", "resolve", "close"]);
  expect(environment).toEqual({ TOKEN: "resolved" });
});

test("activation uses a supplied environment session without opening another", async () => {
  const plan = basePlan([service("web")]);
  const { certificates } = await Effect.runPromise(prepareServiceCertificates(plan));
  let environment: Readonly<Record<string, string>> | undefined;
  const provider = await Effect.runPromise(
    resolvingProvider([], (value) => {
      environment = value;
    }),
  );

  await Effect.runPromise(
    applyActivation({ provider, plan, certificates, reconcile: false, environment: session }).pipe(
      Effect.provideService(EnvironmentValueResolver, unusedResolver),
    ),
  );

  expect(environment).toEqual({ TOKEN: "resolved" });
});

test("activation records a provider-created volume as eligible for initialization", async () => {
  const plan = { ...basePlan([]), stores: [{ name: "data", scope: "app" as const, kind: "data" as const }] };
  const { certificates } = await Effect.runPromise(prepareServiceCertificates(plan));
  const stateStore = makeTestStateStore();
  const identity: VolumeIdentity = {
    coordinationKey: "daemon/data",
    nativeName: "data",
    generation: "first",
    ownerRoot: plan.root,
    origin: "created",
  };
  const provider = await Effect.runPromise(
    prepareProvider({
      ...TestRuntimeProvider,
      locateVolume: () =>
        Effect.succeed({
          coordinationKey: identity.coordinationKey,
          nativeName: identity.nativeName,
          identity,
        }),
      apply: (_plan, options) =>
        Effect.gen(function* () {
          if (options.onVolumeCreated === undefined) return yield* Effect.die("Missing creation recorder");
          yield* options.onVolumeCreated(identity);
          return { changed: true };
        }),
    }),
  );

  await Effect.runPromise(
    applyActivation({ provider, plan, certificates, reconcile: false, environment: session }).pipe(
      Effect.provideService(StateStore, stateStore.service),
      Effect.provideService(EnvironmentValueResolver, unusedResolver),
    ),
  );

  const initialization = await Effect.runPromise(volumeInitialization(stateStore.service, identity));
  expect(await Effect.runPromise(initialization.begin("seed"))).toBe(true);
});

test("activation preserves a before-apply failure and never calls the provider", async () => {
  const plan = basePlan([]);
  const { certificates } = await Effect.runPromise(prepareServiceCertificates(plan));
  const provider = await Effect.runPromise(
    prepareProvider({ ...TestRuntimeProvider, apply: () => Effect.die("Unexpected apply") }),
  );

  const error = await Effect.runPromise(
    applyActivation({
      provider,
      plan,
      certificates,
      reconcile: false,
      environment: session,
      beforeApply: Effect.fail(new CaError({ caId: "admission", message: "Refused", remediation: "Retry." })),
    }).pipe(Effect.provideService(EnvironmentValueResolver, unusedResolver), Effect.flip),
  );

  expect(error).toMatchObject({ _tag: "CaError", caId: "admission" });
});
