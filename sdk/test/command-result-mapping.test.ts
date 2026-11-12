import { expect, test } from "bun:test";
import {
  FailureRoleAnnotation,
  mapDefectCause,
  mapFailures,
  mapStreamFailures,
  mergeFailure,
} from "@lando/sdk/command-result";
import { Cause, Context, Effect, Exit, Stream } from "effect";

test("defect sanitization retains every reason, its kind and annotations", () => {
  const annotation = Context.Reference("test/defect-mapping", { defaultValue: () => "absent" });
  const cause = Cause.annotate(
    Cause.combine(
      mergeFailure(Cause.die("private-primary"), Cause.die("private-cleanup"), "cleanup"),
      Cause.combine(Cause.fail("typed"), Cause.interrupt(7)),
    ),
    Context.make(annotation, "present"),
  );

  const sanitized = mapDefectCause(cause, (_defect, role) => `safe:${role ?? "primary"}`);

  expect(sanitized.reasons.map((reason) => reason._tag)).toEqual(["Die", "Die", "Fail", "Interrupt"]);
  expect(sanitized.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toEqual([
    "safe:primary",
    "safe:cleanup",
  ]);
  expect(sanitized.reasons.filter((reason) => !Cause.isDieReason(reason))).toEqual(
    cause.reasons.filter((reason) => !Cause.isDieReason(reason)),
  );
  expect(
    sanitized.reasons.map((reason) =>
      Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
    ),
  ).toEqual([undefined, "cleanup", undefined, undefined]);
  expect(sanitized.reasons.map((reason) => Context.get(Cause.reasonAnnotations(reason), annotation))).toEqual(
    ["present", "present", "present", "present"],
  );
});

for (const kind of ["effect", "stream"] as const) {
  for (const style of ["data-first", "pipeable"] as const) {
    test(`${kind} ${style} maps primary and cleanup failures while retaining annotations, defects and interrupts`, () => {
      const annotation = Context.Reference("test/mapping", { defaultValue: () => "absent" });
      const cause = Cause.annotate(
        Cause.combine(
          mergeFailure(Cause.fail("primary"), Cause.fail("cleanup"), "cleanup"),
          Cause.combine(Cause.die("defect"), Cause.interrupt(7)),
        ),
        Context.make(annotation, "present"),
      );
      const mapper = (error: string, role: "cleanup" | "rollback" | "peer" | undefined) =>
        `${role ?? "primary"}:${error}`;

      const exit = Effect.runSyncExit(
        kind === "effect"
          ? style === "data-first"
            ? mapFailures(Effect.failCause(cause), mapper)
            : Effect.failCause(cause).pipe(mapFailures(mapper))
          : Stream.runCollect(
              style === "data-first"
                ? mapStreamFailures(Stream.failCause(cause), mapper)
                : Stream.failCause(cause).pipe(mapStreamFailures(mapper)),
            ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toEqual([
          "primary:primary",
          "cleanup:cleanup",
        ]);
        expect(
          exit.cause.reasons.map((reason) =>
            Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation),
          ),
        ).toEqual([undefined, "cleanup", undefined, undefined]);
        expect(
          exit.cause.reasons.map((reason) => Context.get(Cause.reasonAnnotations(reason), annotation)),
        ).toEqual(["present", "present", "present", "present"]);
        expect(exit.cause.reasons.filter((reason) => !Cause.isFailReason(reason))).toEqual(
          cause.reasons.filter((reason) => !Cause.isFailReason(reason)),
        );
      }
    });
  }

  test(`${kind} leaves interrupt-only causes untouched`, () => {
    const cause = Cause.interrupt(7);
    const mapper = () => "unexpected";
    const exit = Effect.runSyncExit(
      kind === "effect"
        ? mapFailures(Effect.failCause(cause), mapper)
        : Stream.runCollect(mapStreamFailures(Stream.failCause(cause), mapper)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons).toEqual(cause.reasons);
  });

  test(`${kind} leaves success untouched without invoking the mapper`, () => {
    let calls = 0;
    const mapper = () => {
      calls++;
      return "unexpected";
    };
    const result =
      kind === "effect"
        ? Effect.runSync(mapFailures(Effect.succeed([1, 2]), mapper))
        : Effect.runSync(Stream.runCollect(mapStreamFailures(Stream.make(1, 2), mapper)));
    expect(result).toEqual([1, 2]);
    expect(calls).toBe(0);
  });
}
