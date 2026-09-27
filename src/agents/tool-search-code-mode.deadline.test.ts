import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CodeModeWorkerResult } from "./code-mode-executor-types.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";

const preparation = vi.hoisted(() => ({
  pending: [] as Array<(result: CodeModeWorkerResult) => void>,
}));

// Executor preparation (plugin resolution and dynamic import) can stall before the guest starts.
vi.mock("./code-mode-executor.js", () => ({
  runCodeModeExecutor: vi.fn(
    () =>
      new Promise<CodeModeWorkerResult>((resolve) => {
        preparation.pending.push(resolve);
      }),
  ),
}));

const {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} = await import("./tool-search.js");
const { testing } = await import("./tool-search.test-support.js");

afterEach(() => {
  vi.useRealTimers();
  testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
});

it("bounds executor preparation by the invocation deadline and disposes a late continuation", async () => {
  vi.useFakeTimers();
  testing.setToolSearchMinCodeTimeoutMsForTest(10);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [] });
  const tool = createToolSearchTools({
    catalogRef,
    config: { tools: { toolSearch: { mode: "code", codeTimeoutMs: 50 } } },
  }).find((candidate) => candidate.name === TOOL_SEARCH_CODE_MODE_TOOL_NAME);
  if (!tool) {
    throw new Error("Missing tool_search_code");
  }

  const rejected = expect(
    tool.execute("preparation-deadline", { code: "return 1;" }),
  ).rejects.toThrow("tool_search_code timed out");
  await vi.advanceTimersByTimeAsync(50);
  await rejected;

  const disposed = createDeferred<void>();
  const late = preparation.pending.shift();
  expect(late).toBeDefined();
  late?.({
    status: "waiting",
    continuation: {
      executor: "quickjs",
      retainedBytes: 0,
      resume: vi.fn(),
      dispose: async () => disposed.resolve(),
    },
    pendingRequests: [],
    canceledRequestIds: [],
    settlementMode: { kind: "awaiting" },
    output: EMPTY_CODE_MODE_OUTPUT,
  });
  await disposed.promise;
});
