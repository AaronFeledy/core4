/**
 * Embedding-host observability boundary.
 *
 * An embedding host owns its tracer, span parent, loggers, minimum log level,
 * and error reporters. Lando's library default (silent loggers) applies only
 * when the host has not provided a value: a reference counts as host-provided
 * when it is present in the fiber context and is not the value Lando itself
 * installed (recorded in `LandoLogDefaults`), so a nested Lando layer still
 * replaces an enclosing Lando default rather than treating it as a host choice.
 */
import { Context, Effect, ErrorReporter, type LogLevel, type Logger, References, Tracer } from "effect";

interface LandoLogDefaults {
  readonly loggers?: ReadonlySet<Logger.Logger<unknown, unknown>> | undefined;
  readonly level?: LogLevel.LogLevel | undefined;
}

const LandoLogDefaults = Context.Reference<LandoLogDefaults>("@lando/engine/LandoLogDefaults", {
  defaultValue: () => ({}),
});

/** Set inside a Lando operation boundary so nested boundaries do not report a defect twice. */
const InsideErrorBoundary = Context.Reference<boolean>("@lando/engine/InsideErrorBoundary", {
  defaultValue: () => false,
});

const hostOwns = <A>(
  context: Context.Context<never>,
  ref: Context.Reference<A>,
  landoValue: A | undefined,
) => {
  const value = Context.getOrUndefined(context, ref);
  return value !== undefined && value !== landoValue;
};

const hasHostLoggers = (context: Context.Context<never>): boolean =>
  hostOwns(context, References.CurrentLoggers, Context.get(context, LandoLogDefaults).loggers);

const hasHostLogLevel = (context: Context.Context<never>): boolean =>
  hostOwns(context, References.MinimumLogLevel, Context.get(context, LandoLogDefaults).level);

/**
 * Applies Lando's built logging defaults under `host`: drops every logging
 * reference the host owns and records the ones Lando keeps.
 */
export const withLandoLogDefaults = <Services>(
  host: Context.Context<never>,
  defaults: Context.Context<Services>,
): Context.Context<Services> => {
  const hostLoggers = hasHostLoggers(host);
  const hostLevel = hasHostLogLevel(host);
  const loggers = hostLoggers ? Context.omit(References.CurrentLoggers)(defaults) : defaults;
  const kept = hostLevel ? Context.omit(References.MinimumLogLevel)(loggers) : loggers;
  return Context.add(kept, LandoLogDefaults, {
    loggers: hostLoggers ? undefined : Context.getOrUndefined(defaults, References.CurrentLoggers),
    level: hostLevel ? undefined : Context.getOrUndefined(defaults, References.MinimumLogLevel),
  });
};

/**
 * Retains runtime services only: never a construction-time tracer, span,
 * tracer toggle, error reporter, or host-owned logging reference.
 */
export const runtimeServiceContext = <Services>(
  context: Context.Context<Services>,
): Context.Context<Exclude<Services, Tracer.ParentSpan>> => {
  const services = Context.omit(
    Tracer.Tracer,
    Tracer.ParentSpan,
    References.TracerEnabled,
    ErrorReporter.CurrentErrorReporters,
  )(context);
  const loggers = hasHostLoggers(services) ? Context.omit(References.CurrentLoggers)(services) : services;
  return hasHostLogLevel(services) ? Context.omit(References.MinimumLogLevel)(loggers) : loggers;
};

/**
 * Runs `program` with the retained runtime services under the caller's
 * observability: call-time host loggers and level win over the runtime's
 * defaults, spans parent to the caller's span, and the outermost Lando boundary
 * reports defects (never tagged failures) to the caller's error reporters.
 */
export const provideRuntime = <A, E, R, Services>(
  program: Effect.Effect<A, E, R>,
  runtime: Context.Context<Services>,
): Effect.Effect<A, E, Exclude<R, Exclude<Services, Tracer.ParentSpan>>> =>
  Effect.contextWith((host: Context.Context<never>) => {
    const services = runtimeServiceContext(runtime);
    const loggers = hasHostLoggers(host) ? Context.omit(References.CurrentLoggers)(services) : services;
    const context = hasHostLogLevel(host) ? Context.omit(References.MinimumLogLevel)(loggers) : loggers;
    if (Context.get(host, InsideErrorBoundary)) {
      return Effect.provide(program, context);
    }
    return Effect.provide(program, Context.add(context, InsideErrorBoundary, true)).pipe(
      Effect.withErrorReporting({ defectsOnly: true }),
    );
  });
