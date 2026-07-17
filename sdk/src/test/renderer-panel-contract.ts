import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect } from "effect";

import type { PanelView, RendererPanelContext } from "../schema/renderer-panel.ts";

import { ContractFailure } from "./_shared.ts";
import {
  PANEL_OP,
  PANEL_READY_DEADLINE_MS,
  PANEL_RENDER_DEADLINE_MS,
  PANEL_RESPONSE_MAX_BYTES,
  decodePanelView,
  decodeReadyResponse,
  encodePanelContextPayload,
  encodePanelInitPayload,
  encodePanelRequest,
} from "./renderer-panel-protocol.ts";

export type RendererPanelContractObservations = {
  readonly readyMs: number;
  readonly renderMs: number;
  readonly lastGood: PanelView | undefined;
  readonly dropped: boolean;
  readonly coalesced: boolean;
};

export type RendererPanelContractInput = {
  /** Absolute path to a panel module whose default export is a RendererPanel. */
  readonly modulePath: string;
  /** Manifest id that must match the module's exported id. */
  readonly manifestId: string;
  /** Contexts to render after ready (in order). */
  readonly contexts: ReadonlyArray<RendererPanelContext>;
  /**
   * When true, fire two contexts back-to-back while the first is in flight to
   * assert coalescing (at most one extra render after the in-flight one).
   */
  readonly coalesce?: boolean;
};

const workerEntryUrl = (): string => pathToFileURL(join(import.meta.dir, "renderer-panel-worker.ts")).href;

const waitForMessage = (
  worker: Worker,
  timeoutMs: number,
): Promise<
  { readonly ok: true; readonly data: ArrayBuffer } | { readonly ok: false; readonly reason: string }
> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    const onMessage = (event: MessageEvent<unknown>) => {
      cleanup();
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        resolve({ ok: true, data });
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        resolve({ ok: true, data: copy as ArrayBuffer });
        return;
      }
      resolve({ ok: false, reason: "non-binary worker message" });
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      resolve({ ok: false, reason: event.message || "worker error" });
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage as EventListener);
      worker.removeEventListener("error", onError as EventListener);
    };
    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", onError as EventListener);
  });

const parseRenderResponse = (buffer: ArrayBuffer): PanelView => {
  const frame = new Uint8Array(buffer);
  if (frame.byteLength < 2) throw new Error("Render response too short");
  if (frame.byteLength > 2 + PANEL_RESPONSE_MAX_BYTES) throw new Error("Render response over ceiling");
  if ((frame[1] ?? 0) === PANEL_OP.failure) {
    const msg = new TextDecoder().decode(frame.subarray(2));
    throw new Error(msg || "panel failure");
  }
  if ((frame[1] ?? 0) !== PANEL_OP.render) throw new Error(`Unexpected op ${frame[1]}`);
  return decodePanelView(frame.subarray(2));
};

/**
 * §13.1 Renderer panel contract harness.
 *
 * Starts a persistent isolated worker on first fixture-slot visibility, performs
 * the 1000ms ready/id handshake, and exercises post-ready render round trips with
 * an 8ms wall-clock deadline. Never imports the panel module in-process.
 */
export const runRendererPanelContract = (
  input: RendererPanelContractInput,
): Effect.Effect<RendererPanelContractObservations, ContractFailure> =>
  Effect.tryPromise({
    try: async () => {
      const worker = new Worker(workerEntryUrl());
      let lastGood: PanelView | undefined;
      let dropped = false;
      let coalesced = false;
      try {
        const readyStarted = performance.now();
        const readyPromise = waitForMessage(worker, PANEL_READY_DEADLINE_MS);
        const initPayload = encodePanelInitPayload(input.manifestId, pathToFileURL(input.modulePath).href);
        const initRequest = encodePanelRequest(PANEL_OP.init, initPayload);
        const initCopy = initRequest.buffer.slice(
          initRequest.byteOffset,
          initRequest.byteOffset + initRequest.byteLength,
        );
        worker.postMessage(initCopy, [initCopy]);
        const ready = await readyPromise;
        const readyMs = performance.now() - readyStarted;
        if (!ready.ok) {
          worker.terminate();
          dropped = true;
          throw new ContractFailure({
            message: `Panel ready handshake failed: ${ready.reason}`,
            assertion: "ready-handshake",
          });
        }
        try {
          const id = decodeReadyResponse(new Uint8Array(ready.data));
          if (id !== input.manifestId) {
            worker.terminate();
            dropped = true;
            throw new ContractFailure({
              message: `Panel ready id ${id} !== manifest ${input.manifestId}`,
              assertion: "ready-id-match",
            });
          }
        } catch (cause) {
          worker.terminate();
          dropped = true;
          if (cause instanceof ContractFailure) throw cause;
          throw new ContractFailure({
            message: cause instanceof Error ? cause.message : String(cause),
            assertion: "ready-decode",
          });
        }

        let renderMs = 0;
        const contexts = [...input.contexts];
        if (input.coalesce === true && contexts.length >= 2) {
          // Fire first render; immediately queue second while first is in flight.
          // Contract: at most one extra invocation after the in-flight one.
          const first = contexts.shift();
          const second = contexts.shift();
          if (first !== undefined && second !== undefined) {
            const payload1 = encodePanelContextPayload(first);
            const req1 = encodePanelRequest(PANEL_OP.render, payload1);
            const copy1 = req1.buffer.slice(req1.byteOffset, req1.byteOffset + req1.byteLength);
            const started = performance.now();
            worker.postMessage(copy1, [copy1]);
            const payload2 = encodePanelContextPayload(second);
            const req2 = encodePanelRequest(PANEL_OP.render, payload2);
            const copy2 = req2.buffer.slice(req2.byteOffset, req2.byteOffset + req2.byteLength);
            worker.postMessage(copy2, [copy2]);
            const r1 = await waitForMessage(worker, PANEL_RENDER_DEADLINE_MS);
            renderMs = Math.max(renderMs, performance.now() - started);
            if (r1.ok && performance.now() - started <= PANEL_RENDER_DEADLINE_MS) {
              try {
                lastGood = parseRenderResponse(r1.data);
              } catch {
                dropped = true;
              }
            } else {
              dropped = true;
            }
            const r2 = await waitForMessage(worker, PANEL_RENDER_DEADLINE_MS);
            if (r2.ok) {
              try {
                lastGood = parseRenderResponse(r2.data);
                coalesced = true;
              } catch {
                dropped = true;
              }
            }
          }
        }

        for (const ctx of contexts) {
          const payload = encodePanelContextPayload(ctx);
          const request = encodePanelRequest(PANEL_OP.render, payload);
          const copy = request.buffer.slice(request.byteOffset, request.byteOffset + request.byteLength);
          const started = performance.now();
          const responsePromise = waitForMessage(worker, PANEL_RENDER_DEADLINE_MS);
          worker.postMessage(copy, [copy]);
          const response = await responsePromise;
          const elapsed = performance.now() - started;
          renderMs = Math.max(renderMs, elapsed);
          if (!response.ok || elapsed > PANEL_RENDER_DEADLINE_MS) {
            worker.terminate();
            dropped = true;
            // Timeout preserves last-good
            return { readyMs, renderMs, lastGood, dropped, coalesced };
          }
          try {
            lastGood = parseRenderResponse(response.data);
          } catch {
            worker.terminate();
            dropped = true;
            return { readyMs, renderMs, lastGood, dropped, coalesced };
          }
        }

        worker.terminate();
        return { readyMs, renderMs, lastGood, dropped, coalesced };
      } catch (cause) {
        worker.terminate();
        if (cause instanceof ContractFailure) throw cause;
        throw new ContractFailure({
          message: cause instanceof Error ? cause.message : String(cause),
          assertion: "panel-contract",
        });
      }
    },
    catch: (cause) =>
      cause instanceof ContractFailure
        ? cause
        : new ContractFailure({
            message: cause instanceof Error ? cause.message : String(cause),
            assertion: "panel-contract",
          }),
  });

export const makeRendererPanelContractSuite = runRendererPanelContract;
