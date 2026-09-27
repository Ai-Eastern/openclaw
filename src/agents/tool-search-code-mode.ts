import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { CodeModeHeadlessAbortError, CodeModeHeadlessTimeoutError } from "./code-mode-errors.js";
import type {
  CodeModeExecutorContinuation,
  CodeModeExecutorInlineHost,
} from "./code-mode-executor-types.js";
import { runCodeModeExecutor } from "./code-mode-executor.js";
import { createHeadlessDeadlineScope } from "./code-mode-headless.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import {
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  MAX_CODE_MODE_PENDING_TOOL_CALLS,
  type CodeModeNamespaceDescriptor,
  type CodeModeSettlementMode,
  type CodeModeWorkerBoundary,
  type CodeModeWorkerPayload,
  type PendingBridgeRequest,
  type SettledBridgeRequest,
} from "./code-mode-worker-types.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchConfig, ToolSearchToolContext } from "./tool-search-types.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const BRIDGE_ALLOWLIST_MESSAGE =
  "tool_search_code exposes only openclaw.tools.search, openclaw.tools.describe, and openclaw.tools.call.";
// Tool Search promises start lazily; the shared namespace starts requests eagerly.
const TOOL_SEARCH_PRELUDE = `;(() => {
  const raw = globalThis.openclaw.tools;
  const lazy = (call) => (...args) => {
    let promise;
    const start = () => (promise ??= call(...args));
    return Object.freeze({
      then: (resolve, reject) => start().then(resolve, reject),
      catch: (reject) => start().catch(reject),
      finally: (onFinally) => start().finally(onFinally),
    });
  };
  Object.defineProperty(globalThis, "openclaw", {
    value: Object.freeze({ tools: Object.freeze({
      search: lazy(raw.search),
      describe: lazy(raw.describe),
      call: lazy(raw.call),
    }) }),
    enumerable: true,
    writable: false,
    configurable: false,
  });
})();
`;
const TOOL_SEARCH_NAMESPACE: CodeModeNamespaceDescriptor = {
  id: "openclaw",
  globalName: "openclaw",
  scope: {
    kind: "object",
    entries: [
      [
        "tools",
        {
          kind: "object",
          entries: ["search", "describe", "call"].map((method) => [
            method,
            { kind: "function", path: [method] },
          ]),
        },
      ],
    ],
  },
};

type PendingCall = {
  request: PendingBridgeRequest;
  controller: AbortController;
  promise: Promise<void>;
  settled?: { response: SettledBridgeRequest; sequence: number };
};

export async function runCodeMode(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  code: string;
  config: ToolSearchConfig;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  onRuntime?: (runtime: ToolSearchRuntime) => void;
}) {
  const scope = createHeadlessDeadlineScope(
    params.signal,
    params.config.codeTimeoutMs,
    "tool_search_code",
  );
  const runtime = new ToolSearchRuntime(params.ctx, params.config, { validateInput: true });
  const output = new CodeModeOutputState(MAX_OUTPUT_BYTES);
  const pending = new Map<string, PendingCall>();
  let sequence = 0;
  let continuation: CodeModeExecutorContinuation | undefined;
  const remainingMs = () => {
    scope.signal.throwIfAborted();
    const remaining = Math.ceil(scope.deadline - performance.now());
    if (remaining <= 0) {
      throw new CodeModeHeadlessTimeoutError("tool_search_code timed out");
    }
    return remaining;
  };
  const dispatchRequest = async (request: PendingBridgeRequest, signal: AbortSignal) => {
    const [namespace, path, args] = request.args;
    if (
      request.method !== "namespace" ||
      namespace !== "openclaw" ||
      !Array.isArray(path) ||
      path.length !== 1 ||
      (path[0] !== "search" && path[0] !== "describe" && path[0] !== "call") ||
      !Array.isArray(args)
    ) {
      throw new Error(BRIDGE_ALLOWLIST_MESSAGE);
    }
    signal.throwIfAborted();
    return runCodeModeBridgeRequest(runtime, path[0], args, {
      parentToolCallId: params.toolCallId,
      signal,
      onUpdate: params.onUpdate,
    });
  };
  const dispatch = (
    boundary: Pick<CodeModeWorkerBoundary, "pendingRequests" | "canceledRequestIds">,
  ) => {
    for (const id of boundary.canceledRequestIds) {
      pending.get(id)?.controller.abort();
      pending.delete(id);
    }
    for (const request of boundary.pendingRequests) {
      if (pending.has(request.id)) {
        continue;
      }
      const controller = new AbortController();
      const entry: PendingCall = { request, controller, promise: Promise.resolve() };
      pending.set(request.id, entry);
      const settle = (ok: boolean, json: string) => {
        entry.settled = { response: { id: request.id, ok, json }, sequence: ++sequence };
      };
      entry.promise = dispatchRequest(request, AbortSignal.any([scope.signal, controller.signal]))
        .then((value) => settle(true, JSON.stringify(toToolSearchJsonSafe(value))))
        .catch((error: unknown) =>
          settle(false, JSON.stringify(error instanceof Error ? error.message : String(error))),
        );
    }
  };
  const waitForSettlement = (mode: CodeModeSettlementMode): Promise<void> => {
    const required = [...pending.values()].filter(
      (entry) => mode.kind === "awaiting" || mode.requiredRequestIds.includes(entry.request.id),
    );
    const outstanding = required.filter((entry) => !entry.settled);
    if (
      outstanding.length === 0 ||
      (mode.kind === "awaiting" && outstanding.length < required.length)
    ) {
      return Promise.resolve();
    }
    return (
      mode.kind === "draining"
        ? Promise.all(outstanding.map((entry) => entry.promise))
        : Promise.race(outstanding.map((entry) => entry.promise))
    ).then(() => undefined);
  };
  const takeSettled = () => {
    const ready = [...pending.values()].flatMap((entry) => (entry.settled ? [entry.settled] : []));
    ready.sort((left, right) => left.sequence - right.sequence);
    for (const { response } of ready) {
      pending.delete(response.id);
    }
    return ready.map(({ response }) => response);
  };
  const pendingRequests = () => [...pending.values()].map((entry) => entry.request);
  const inlineHost: CodeModeExecutorInlineHost = {
    onNetworkContent: () => runtime.observeNetworkContent(params.toolCallId),
    onBoundary: async (boundary, context) => {
      output.append(boundary.output);
      dispatch(boundary);
      if (context.yieldSignal.aborted) {
        return { kind: "checkpoint" };
      }
      let onPressure: (() => void) | undefined;
      try {
        const ready = await scope.wait(
          Promise.race([
            waitForSettlement(boundary.settlementMode).then(() => true),
            new Promise<false>((resolve) => {
              onPressure = () => resolve(false);
              context.yieldSignal.addEventListener("abort", onPressure, { once: true });
            }),
          ]),
        );
        if (!ready || context.yieldSignal.aborted) {
          return { kind: "checkpoint" };
        }
        return {
          kind: "continue",
          timeoutMs: Math.min(context.maxTimeoutMs, remainingMs()),
          settledRequests: takeSettled(),
          pendingRequests: pendingRequests(),
        };
      } finally {
        if (onPressure) {
          context.yieldSignal.removeEventListener("abort", onPressure);
        }
      }
    },
  };
  const config = {
    timeoutMs: params.config.codeTimeoutMs,
    memoryLimitBytes: MEMORY_LIMIT_BYTES,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    maxPendingToolCalls: MAX_CODE_MODE_PENDING_TOOL_CALLS,
    maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
  };
  const run = async (input: CodeModeWorkerPayload<CodeModeExecutorContinuation>) => {
    const remaining = remainingMs();
    const execution = runCodeModeExecutor(
      { ...input, config: { ...config, timeoutMs: remaining } },
      {
        executor: "quickjs",
        runtimeConfig: params.ctx.runtimeConfig ?? params.ctx.config,
        timeoutMs: remaining + CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
        signal: scope.signal,
        inlineHost,
      },
    );
    try {
      // Executor preparation (plugin resolution and import) must not outlast the deadline.
      return await scope.wait(execution);
    } catch (error) {
      void execution.then(
        (late) => (late.status === "waiting" ? late.continuation.dispose() : undefined),
        () => undefined,
      );
      throw error;
    }
  };
  try {
    params.onRuntime?.(runtime);
    let result = await run({
      kind: "exec",
      source: params.code,
      prelude: TOOL_SEARCH_PRELUDE,
      config,
      catalog: [],
      apiFiles: [],
      namespaces: [TOOL_SEARCH_NAMESPACE],
      swarmEnabled: false,
    });
    for (;;) {
      continuation = result.status === "waiting" ? result.continuation : undefined;
      scope.signal.throwIfAborted();
      output.append(result.output);
      if (result.status === "completed") {
        const bounded = output.take({ value: result.value });
        return {
          ok: true,
          value: bounded.value ?? null,
          logs: bounded.output.map((entry) => {
            if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
              return entry.text;
            }
            return JSON.stringify(isRecord(entry) && entry.type === "json" ? entry.value : entry);
          }),
          telemetry: runtime.telemetry(),
        };
      }
      if (result.status === "failed") {
        if (result.code === "timeout") {
          throw new CodeModeHeadlessTimeoutError("tool_search_code timed out");
        }
        if (result.code === "aborted") {
          throw new CodeModeHeadlessAbortError("tool_search_code aborted");
        }
        if (result.code === "runtime_unavailable") {
          throw new Error(
            `tool_search_code could not start its QuickJS sandbox: ${result.error} The bundled code-mode-quickjs plugin must not be denied (plugins.deny) or disabled (plugins.entries.code-mode-quickjs.enabled: false), or set tools.toolSearch.mode to "tools".`,
          );
        }
        throw new Error(result.error);
      }
      dispatch(result);
      if (pending.size === 0) {
        throw new Error("tool_search_code is waiting without pending bridge requests");
      }
      await scope.wait(waitForSettlement(result.settlementMode));
      result = await run({
        kind: "resume",
        continuation: result.continuation,
        config,
        settledRequests: takeSettled(),
        pendingRequests: pendingRequests(),
      });
    }
  } finally {
    for (const entry of pending.values()) {
      entry.controller.abort();
    }
    scope.cleanup();
    await continuation?.dispose();
  }
}

async function runCodeModeBridgeRequest(
  runtime: ToolSearchRuntime,
  method: "search" | "describe" | "call",
  args: unknown,
  options?: {
    parentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<unknown> {
  const values = Array.isArray(args) ? args : [];
  switch (method) {
    case "search": {
      const query = values[0];
      if (typeof query !== "string") {
        throw new ToolInputError("search query must be a string.");
      }
      const optionsLocal = isRecord(values[1]) ? values[1] : undefined;
      return await runtime.search(query, {
        parentToolCallId: options?.parentToolCallId,
        limit: typeof optionsLocal?.limit === "number" ? optionsLocal.limit : undefined,
      });
    }
    case "describe": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("describe id must be a string.");
      }
      return await runtime.describe(id, {
        recoverySurface: "code-mode",
        parentToolCallId: options?.parentToolCallId,
      });
    }
    case "call": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("call id must be a string.");
      }
      return await runtime.call(id, values[1] ?? {}, {
        ...options,
        recoverySurface: "code-mode",
      });
    }
  }
  throw new ToolInputError("Unsupported tool_search_code bridge method.");
}

export function readToolSearchCode(args: unknown): string {
  const params = asToolParamsRecord(args);
  const code = params.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new ToolInputError("code must be a non-empty string.");
  }
  return code;
}
