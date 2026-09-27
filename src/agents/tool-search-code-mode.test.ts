import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runCodeMode } from "./tool-search-code-mode.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const executeTarget = vi.fn<AnyAgentTool["execute"]>();
const target: AnyAgentTool = {
  name: "sandbox_target",
  label: "Sandbox target",
  description: "Target for sandbox isolation checks",
  parameters: { type: "object", properties: {} },
  execute: executeTarget,
};
const catalogRef = createToolSearchCatalogRef();
registerHeadlessToolSearchCatalog({ catalogRef, tools: [target] });

function controlTool(codeTimeoutMs = 10_000): AnyAgentTool {
  const tool = createToolSearchTools({
    catalogRef,
    config: { tools: { toolSearch: { mode: "code", codeTimeoutMs } } },
  }).find((candidate) => candidate.name === TOOL_SEARCH_CODE_MODE_TOOL_NAME);
  if (!tool) {
    throw new Error("Missing tool_search_code");
  }
  return tool;
}

const codeTool = controlTool();

async function run(code: string): Promise<Record<string, unknown>> {
  const result = await codeTool.execute("sandbox-test", { code });
  if (!isRecord(result.details)) {
    throw new Error("Expected tool_search_code result details");
  }
  expect(result.details.ok).toBe(true);
  return result.details;
}

beforeEach(() => {
  executeTarget.mockReset();
  executeTarget.mockResolvedValue(jsonResult({ reached: true }));
});

describe("tool_search_code QuickJS sandbox", () => {
  it("starts Promise.all searches concurrently without leaking prelude names into the cell", async () => {
    const started = createDeferred<void>();
    const completion = createDeferred<void>();
    const queries: string[] = [];
    const execution = runCodeMode({
      toolCallId: "sandbox-parallel-search",
      ctx: { catalogRef },
      config: resolveToolSearchConfig({ tools: { toolSearch: true } }),
      code: `
        const lazy = 1, start = 2, promise = 3;
        const results = await Promise.all([
          openclaw.tools.search("sandbox"),
          openclaw.tools.search("target"),
        ]);
        return { locals: [lazy, start, promise], matches: results.map(hits => hits[0].name) };
      `,
      onRuntime: (runtime) => {
        const search = runtime.search;
        runtime.search = async (...args) => {
          queries.push(args[0]);
          if (queries.length === 2) {
            started.resolve();
          }
          await completion.promise;
          return search(...args);
        };
      },
    });
    try {
      await Promise.race([
        started.promise,
        execution.then(() => {
          throw new Error("Cell returned before both searches started");
        }),
      ]);
      expect(queries).toEqual(["sandbox", "target"]);
      completion.resolve();
      expect((await execution).value).toEqual({
        locals: [1, 2, 3],
        matches: ["sandbox_target", "sandbox_target"],
      });
      expect(executeTarget).not.toHaveBeenCalled();
    } finally {
      completion.resolve();
    }
  });

  it.each(['require("fs")', 'await import("node:fs")'])(
    "rejects filesystem module access through %s before dispatch",
    async (expression) => {
      await expect(
        run(`${expression}; return await openclaw.tools.call("sandbox_target", {});`),
      ).rejects.toThrow("module access is disabled");
      expect(executeTarget).not.toHaveBeenCalled();
    },
  );

  it("keeps runtime, environment, filesystem, network, and worker capabilities out of the guest", async () => {
    const details = await run(`
      const probes = [
        ["Function constructor", () => Function("return process")()],
        ["bridge constructor", () => openclaw.tools.call.constructor.constructor("return process")()],
        ["process.binding", () => process.binding("fs")],
        ["process.env", () => process.env],
        ["globalThis.process", () => globalThis.process],
        ["Bun.file", () => Bun.file("sandbox-secret")],
        ["Deno", () => globalThis.Deno],
        ["WebAssembly", () => globalThis.WebAssembly],
        ["Worker", () => new Worker("data:text/javascript,0")],
        ["fetch", () => globalThis.fetch],
        ["XMLHttpRequest", () => globalThis.XMLHttpRequest],
        ["WebSocket", () => globalThis.WebSocket],
      ];
      const outcomes = [];
      for (const [name, probe] of probes) {
        let outcome;
        try { outcome = probe() === undefined ? "absent" : "escaped"; }
        catch (error) { outcome = error instanceof ReferenceError ? "rejected" : "unexpected error"; }
        outcomes.push([name, outcome]);
        if (outcome === "escaped") await openclaw.tools.call("sandbox_target", {});
      }
      return outcomes;
    `);
    expect(details.value).toEqual([
      ["Function constructor", "rejected"],
      ["bridge constructor", "rejected"],
      ["process.binding", "rejected"],
      ["process.env", "rejected"],
      ["globalThis.process", "absent"],
      ["Bun.file", "rejected"],
      ["Deno", "absent"],
      ["WebAssembly", "absent"],
      ["Worker", "rejected"],
      ["fetch", "absent"],
      ["XMLHttpRequest", "absent"],
      ["WebSocket", "absent"],
    ]);
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("constructor access through a search result reaches only the guest global", async () => {
    const details = await run(`
      const scope = (await openclaw.tools.search("sandbox"))
        .constructor.constructor("return this")();
      const capabilities = ["process", "Bun", "Deno", "require", "fetch", "Worker"];
      const escaped = capabilities.filter((name) => scope[name] !== undefined);
      if (escaped.length) await openclaw.tools.call("sandbox_target", {});
      return { guestGlobal: scope === globalThis, escaped };
    `);
    expect(details.value).toEqual({ guestGlobal: true, escaped: [] });
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("isolates guest prototype pollution from host and returned bridge objects", async () => {
    const details = await run(`
      Object.prototype.polluted = 1;
      Array.prototype.x = "guest";
      const search = await openclaw.tools.search("sandbox");
      return { guestObject: ({}).polluted, guestArray: [].x, search, object: {}, array: [] };
    `);
    expect(details.value).toMatchObject({ guestObject: 1, guestArray: "guest" });
    expect({}).not.toHaveProperty("polluted");
    expect([]).not.toHaveProperty("x");
    if (!isRecord(details.value)) {
      throw new Error("Expected returned guest objects");
    }
    for (const value of [
      details.value,
      details.value.search,
      details.value.object,
      details.value.array,
    ]) {
      expect(value).not.toHaveProperty("polluted");
      expect(value).not.toHaveProperty("x");
    }
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("rejects additional Code Mode host capabilities through the Tool Search allowlist", async () => {
    const details = await run(`
      const probes = [
        () => nodes.list(),
        () => catalog.search("sandbox"),
        () => results.save(1),
        () => results.load("missing"),
        () => results.delete("missing"),
        () => skills.list(),
        () => skills.read("missing"),
        () => yield_control(),
      ];
      const errors = [];
      for (const probe of probes) {
        try {
          await probe();
          await openclaw.tools.call("sandbox_target", {});
          errors.push("unexpected success");
        } catch (error) { errors.push(error.message); }
      }
      return errors;
    `);
    expect(details.value).toEqual(
      Array.from(
        { length: 8 },
        () =>
          "tool_search_code exposes only openclaw.tools.search, openclaw.tools.describe, and openclaw.tools.call.",
      ),
    );
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("terminates a synchronous infinite loop within the invocation deadline", async () => {
    // This actual guest interrupt cannot be proved by advancing the host's fake clock.
    const started = performance.now();
    await expect(
      controlTool(1000).execute("sandbox-spin", { code: "while (true) {}" }),
    ).rejects.toThrow("tool_search_code timed out");
    expect(performance.now() - started).toBeLessThan(3000);
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("aborts a parked bridged call when the parent aborts", async () => {
    const parent = new AbortController();
    const started = createDeferred<AbortSignal>();
    executeTarget.mockImplementation(async (_id, _input, signal) => {
      if (!signal) {
        throw new Error("Expected a host call AbortSignal");
      }
      const aborted = createDeferred<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve(signal);
      await aborted.promise;
      return jsonResult({ aborted: true });
    });
    const result = codeTool.execute(
      "sandbox-abort",
      { code: 'return await openclaw.tools.call("sandbox_target", {});' },
      parent.signal,
    );
    const rejected = expect(result).rejects.toThrow("tool_search_code aborted");
    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    parent.abort();
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(executeTarget).toHaveBeenCalledTimes(1);
  });

  it("bounds console floods with an explicit truncation marker", async () => {
    const details = await run(`
      for (let i = 0; i < 1000; i++) console.log("x".repeat(512));
      return "done";
    `);
    expect(details.value).toBe("done");
    expect(details.logs).toContain("[console output truncated]");
    expect(JSON.stringify(details.logs).length).toBeLessThan(16 * 1024);
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("bounds an oversized return value with a truncation marker", async () => {
    const details = await run('return "x".repeat(10 * 1024 * 1024 + 1024);');
    expect(details.value).toMatchObject({
      truncated: true,
      guidance: "Output truncated; rerun with narrower args.",
      omittedBytes: expect.any(Number),
    });
    expect(Buffer.byteLength(JSON.stringify(details.value))).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it("fails a guest memory bomb cleanly and keeps the executor usable", async () => {
    await expect(run("return new Uint8Array(128 * 1024 * 1024).length;")).rejects.toThrow(
      /out of memory|allocation failed/i,
    );
    expect((await run("return 42;")).value).toBe(42);
    expect(executeTarget).not.toHaveBeenCalled();
  });
});
