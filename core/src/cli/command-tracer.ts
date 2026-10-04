import type { CommandTrace, CommandTraceSpan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { Cause, Clock, Effect, Exit, Option, Tracer } from "effect";

export const COMMAND_TRACE_CAPACITY = 10_000;

export const makeCommandTracer = (options: {
  readonly redactor: Redactor;
  readonly delegate?: Tracer.Tracer;
  readonly capacity?: number;
}) => {
  const capacity = options.capacity ?? COMMAND_TRACE_CAPACITY;
  const spans: CommandTraceSpan[] = [];
  const pendingExports = new Map<string, () => void>();
  let redactor = options.redactor;
  let droppedSpans = 0;
  let root: Tracer.Span | undefined;
  let rootStart = 0n;
  let totalDurationMs = 0;
  const primitive = (value: unknown): string | number | boolean => {
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    return redactor.redactString(typeof value === "string" ? value : String(value));
  };
  const attributes = (values: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [redactor.redactString(key), primitive(value)]),
    );
  const tracer = Tracer.make({
    span(input) {
      const safeInput = {
        ...input,
        name: redactor.redactString(input.name),
        links: input.links.map((link) => ({ ...link, attributes: attributes(link.attributes) })),
      };
      const inner = options.delegate?.span(safeInput) ?? new Tracer.NativeSpan(safeInput);
      let spanStatus = inner.status;
      const events: Array<{
        readonly name: string;
        readonly time: bigint;
        readonly values?: Record<string, string | number | boolean>;
      }> = [];
      const span: Tracer.Span = {
        _tag: "Span",
        name: inner.name,
        spanId: inner.spanId,
        traceId: inner.traceId,
        parent: inner.parent,
        annotations: inner.annotations,
        sampled: inner.sampled,
        kind: inner.kind,
        get status() {
          return spanStatus;
        },
        get attributes() {
          return inner.attributes;
        },
        get links() {
          return inner.links;
        },
        attribute(key, value) {
          inner.attribute(redactor.redactString(key), primitive(value));
        },
        event(name, time, values) {
          const safeName = redactor.redactString(name);
          const safeValues = values === undefined ? undefined : attributes(values);
          if (options.delegate === undefined) inner.event(safeName, time, safeValues);
          else
            events.push({
              name: safeName,
              time,
              ...(safeValues === undefined ? {} : { values: safeValues }),
            });
        },
        addLinks(links) {
          inner.addLinks(links.map((link) => ({ ...link, attributes: attributes(link.attributes) })));
        },
        end(time, exit) {
          if (spanStatus._tag === "Ended") return;
          const durationMs = Math.max(0, Number(time - input.startTime) / 1_000_000);
          const status = Exit.isSuccess(exit)
            ? "ok"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupted"
              : "error";
          const retained: CommandTraceSpan = {
            id: inner.spanId,
            name: inner.name,
            ...(Option.isSome(inner.parent) ? { parent: inner.parent.value.spanId } : {}),
            startOffsetMs: Math.max(0, Number(input.startTime - rootStart) / 1_000_000),
            durationMs,
            status,
            attributes: attributes(Object.fromEntries(inner.attributes)),
          };
          if (span === root) totalDurationMs = durationMs;
          if (spans.length < capacity) spans.push(retained);
          else {
            droppedSpans += 1;
            if (span === root && capacity > 0) {
              spans.shift();
              spans.push(retained);
            }
          }
          const safeExit = Exit.isSuccess(exit)
            ? Exit.void
            : status === "interrupted"
              ? Exit.interrupt(0)
              : Exit.fail(redactor.redactString(Cause.pretty(exit.cause)));
          spanStatus = { _tag: "Ended", startTime: input.startTime, endTime: time, exit: safeExit };
          if (options.delegate === undefined) inner.end(time, safeExit);
          else
            pendingExports.set(inner.spanId, () => {
              for (const [key, value] of inner.attributes) inner.attribute(key, primitive(value));
              for (const event of events)
                inner.event(
                  redactor.redactString(event.name),
                  event.time,
                  event.values === undefined ? undefined : attributes(event.values),
                );
              const exportExit =
                Exit.isFailure(safeExit) && !Cause.hasInterruptsOnly(safeExit.cause)
                  ? Exit.fail(redactor.redactString(Cause.pretty(safeExit.cause)))
                  : safeExit;
              inner.end(time, exportExit);
            });
        },
      };
      if (input.root && root === undefined) {
        root = span;
        rootStart = input.startTime;
      }
      return span;
    },
  });
  const snapshot = (): CommandTrace => ({
    totalDurationMs,
    spans: [...spans].sort(
      (a, b) =>
        a.startOffsetMs - b.startOffsetMs || Number(a.parent !== undefined) - Number(b.parent !== undefined),
    ),
    droppedSpans,
  });
  const finish = (exit: Exit.Exit<unknown, unknown>) =>
    Effect.map(Clock.currentTimeNanos, (now) => {
      root?.end(now, exit);
      return snapshot();
    });
  const setRedactor = (next: Redactor): void => {
    redactor = next;
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (span !== undefined) spans[index] = { ...span, attributes: attributes(span.attributes) };
    }
  };
  const exportSpans = Effect.sync(() => {
    for (const send of pendingExports.values()) send();
    pendingExports.clear();
  });
  return { tracer, snapshot, finish, setRedactor, exportSpans, capacity };
};

export type CommandTraceCapture = ReturnType<typeof makeCommandTracer>;

export const formatCommandTrace = (trace: CommandTrace): string => {
  const children = new Map<string | undefined, CommandTraceSpan[]>();
  const ids = new Set(trace.spans.map((span) => span.id));
  for (const span of trace.spans) {
    const parent = span.parent !== undefined && ids.has(span.parent) ? span.parent : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(span);
    children.set(parent, siblings);
  }
  const lines: string[] = [];
  const visit = (parent: string | undefined, depth: number): void => {
    let collapsed = 0;
    for (const span of children.get(parent) ?? []) {
      if (parent !== undefined && span.durationMs < trace.totalDurationMs * 0.01) {
        const count = (id: string): number =>
          1 + (children.get(id) ?? []).reduce((sum, child) => sum + count(child.id), 0);
        collapsed += count(span.id);
        continue;
      }
      lines.push(`${"  ".repeat(depth)}${span.name} ${span.durationMs.toFixed(2)}ms [${span.status}]`);
      visit(span.id, depth + 1);
    }
    if (collapsed > 0) lines.push(`${"  ".repeat(depth)}${collapsed} spans under 1%`);
  };
  visit(undefined, 0);
  if (trace.droppedSpans > 0) lines.push(`${trace.droppedSpans} spans dropped`);
  return lines.join("\n");
};
