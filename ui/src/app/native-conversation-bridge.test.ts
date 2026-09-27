/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "./context.ts";
import { createNativeConversationBridge } from "./native-conversation-bridge.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fixture() {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const changed = () => listeners.forEach((listener) => listener());
  const data = { kind: "session", agentId: "main", sessionKey: "agent:main:main" };
  const match = { routeId: "chat", status: "success", data };
  const snapshot = {
    phase: "connected",
    assistantAgentId: "main",
    hello: null,
    lastErrorAuthReason: null as string | null,
  };
  const row = { key: data.sessionKey, label: "Native conversation", hasActiveRun: false };
  const navigateAndWait = vi.fn(async () => {});
  const context = {
    basePath: "",
    gateway: { snapshot, subscribe },
    router: {
      getState: () => ({
        matches: [match],
        pendingMatches: [],
      }),
      subscribe,
    },
    sessions: {
      presentation: { result: { sessions: [row] } },
      state: { result: { sessions: [row] } },
      subscribe,
    },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main" } },
    navigateAndWait,
  } as unknown as ApplicationContext;
  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", {
    platform: "macos",
    formFactor: "desktop",
    surface: "conversation",
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", { contract: 1 });
  const reply = vi.fn((_message: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve({ ok: true }),
  );
  const handler = {
    postMessage(message: Record<string, unknown>) {
      expect(this).toBe(handler);
      messages.push(message);
      return reply(message);
    },
  };
  vi.stubGlobal("webkit", { messageHandlers: { openclawConversation: handler } });
  const bridge = createNativeConversationBridge(context)!;
  cleanups.push(() => bridge.dispose());
  const documentId = (
    window as Window &
      typeof globalThis & { __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__: { documentId: string } }
  )["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"].documentId;
  const command = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    window.dispatchEvent(
      new CustomEvent("openclaw:native-conversation-command", {
        detail: { contract: 1, documentId, requestId: "request-1", type, payload, ...extra },
      }),
    );
  return {
    messages,
    reply,
    bridge,
    documentId,
    command,
    data,
    snapshot,
    row,
    changed,
    navigateAndWait,
    context,
    match,
  };
}

async function flush() {
  // Drain the serialized command and postMessage microtasks, without timer polling.
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

describe("native conversation contract", () => {
  it("requires the conversation capability and a callable handler", () => {
    const f = fixture();
    f.bridge.dispose();
    for (const capability of [undefined, { contract: 2 }]) {
      vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", capability);
      expect(createNativeConversationBridge(f.context)).toBeNull();
    }
    vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", { contract: 1 });
    vi.stubGlobal("webkit", { messageHandlers: { openclawConversation: { postMessage: false } } });
    expect(createNativeConversationBridge(f.context)).toBeNull();
  });

  it("announces the document before change-only, monotonically revised state", async () => {
    const f = fixture();
    await flush();
    expect(f.messages.map((message) => message.type)).toEqual(["ready", "state"]);
    expect(f.messages[0]).toMatchObject({
      contract: 1,
      documentId: f.documentId,
      surface: "conversation",
      capabilities: ["navigate", "presentation", "focus-composer"],
    });
    f.changed();
    await flush();
    expect(f.messages).toHaveLength(2);
    f.row.hasActiveRun = true;
    f.changed();
    f.snapshot.phase = "offline";
    f.snapshot.lastErrorAuthReason = "token_missing";
    f.changed();
    await flush();
    expect(f.messages.filter((message) => message.type === "state")).toMatchObject([
      {
        revision: 1,
        title: "Native conversation",
        run: { active: false },
        connection: "connected",
      },
      { revision: 2, run: { active: true } },
      { revision: 3, connection: "signed-out" },
    ]);
    expect(
      f.messages.every((message) => message.documentId === f.documentId && message.contract === 1),
    ).toBe(true);
  });

  it.each([
    ["presentation", { visible: "yes", active: true }, {}, "invalid-command"],
    ["navigate", { agentId: "main" }, {}, "invalid-command"],
    ["focus-composer", { extra: true }, {}, "invalid-command"],
    ["future-command", {}, {}, "unsupported"],
    ["presentation", { visible: true, active: true }, { contract: 2 }, "unsupported"],
    [
      "navigate",
      { agentId: "main", sessionKey: "agent:main:other" },
      { documentId: "old-document" },
      "stale-document",
    ],
  ] as const)("rejects %s with %j (%j)", async (type, payload, extra, error) => {
    const f = fixture();
    f.command(type, payload, extra);
    await flush();
    expect(f.messages.at(-1)).toMatchObject({
      type: "command-result",
      requestId: "request-1",
      ok: false,
      error,
    });
    expect(f.navigateAndWait).not.toHaveBeenCalled();
  });

  it("switches through the in-page owner once and publishes state before answering once", async () => {
    const f = fixture();
    const gate = createDeferred();
    f.navigateAndWait.mockImplementation(async () => {
      await gate.promise;
      f.data.sessionKey = "agent:main:next";
      f.changed();
    });
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
    await flush();
    expect(f.navigateAndWait).toHaveBeenCalledTimes(1);
    expect(f.navigateAndWait).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: expect.stringContaining("/chat/") }),
    );
    expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
    gate.resolve();
    await flush();
    expect(f.messages.slice(-2)).toMatchObject([
      { type: "state", context: { agentId: "main", sessionKey: "agent:main:next" } },
      { type: "command-result", ok: true },
    ]);
    expect(f.messages.some((message) => message.type === "route-changed")).toBe(false);
  });

  it.each([true, false])(
    "awaits state publication before the navigation result (accepted: %s)",
    async (ok) => {
      const f = fixture();
      await flush();
      const delivery = createDeferred<unknown>();
      f.reply.mockImplementation((message) =>
        message.type === "state" ? delivery.promise : Promise.resolve({ ok: true }),
      );
      f.navigateAndWait.mockImplementation(async () => {
        f.data.sessionKey = "agent:main:next";
        f.changed();
      });
      f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
      await flush();
      expect(f.messages.at(-1)).toMatchObject({
        type: "state",
        context: { sessionKey: "agent:main:next" },
      });
      expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
      delivery.resolve(ok ? { ok: true } : { ok: false, error: "unsupported" });
      await flush();
      expect(f.messages.at(-1)).toMatchObject({
        type: "command-result",
        ok,
        ...(ok ? {} : { error: "navigation-failed" }),
      });
    },
  );

  it("rejects a resolved navigation that did not select its target", async () => {
    const f = fixture();
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:missing" });
    await flush();
    expect(f.messages.at(-1)).toMatchObject({
      type: "command-result",
      ok: false,
      error: "navigation-failed",
    });
  });

  it("reports web navigation that supersedes a pending native command", async () => {
    const f = fixture();
    const gate = createDeferred();
    f.navigateAndWait.mockReturnValue(gate.promise);
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:native" });
    await flush();
    f.data.sessionKey = "agent:main:web";
    f.changed();
    gate.resolve();
    await flush();
    expect(f.messages).toContainEqual(
      expect.objectContaining({ type: "command-result", ok: false, error: "navigation-failed" }),
    );
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: "route-changed",
        agentId: "main",
        sessionKey: "agent:main:web",
      }),
    );
  });

  it("projects shared global rows only from the selected agent", async () => {
    const f = fixture();
    f.data.sessionKey = "global";
    f.data.agentId = "research";
    f.context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    };
    Object.assign(f.row, {
      key: "global",
      agentId: "main",
      label: "Another agent",
      hasActiveRun: true,
    });
    f.context.sessions.presentation.result?.sessions.push({
      key: "global",
      agentId: "research",
      label: "Research conversation",
      hasActiveRun: false,
      kind: "global",
      updatedAt: null,
    });
    f.changed();
    await flush();
    expect(f.messages.findLast((message) => message.type === "state")).toMatchObject({
      context: { agentId: "research", sessionKey: "global" },
      title: "Research conversation",
      run: { active: false },
    });
  });

  it("reports route changes and hands non-chat navigation to Dashboard", async () => {
    const f = fixture();
    f.match.status = "pending";
    f.changed();
    f.data.sessionKey = "agent:main:linked";
    f.match.status = "success";
    f.changed();
    expect(
      f.bridge.interceptNavigation({ pathname: "/settings", search: "?section=general", hash: "" }),
    ).toBe(true);
    expect(f.bridge.interceptNavigation({ pathname: "/chat", search: "", hash: "" })).toBe(false);
    await flush();
    expect(f.messages).toContainEqual({
      contract: 1,
      documentId: f.documentId,
      type: "route-changed",
      agentId: "main",
      sessionKey: "agent:main:linked",
      reason: "other",
    });
    expect(f.messages.at(-1)).toMatchObject({
      type: "open-dashboard",
      path: "/settings",
      search: "?section=general",
    });
  });

  it("applies presentation and focuses the existing composer", async () => {
    const f = fixture();
    document.body.innerHTML =
      '<openclaw-chat-pane class="chat-pane-cache__pane--active"><div class="agent-chat__composer-combobox"><textarea></textarea></div></openclaw-chat-pane>';
    const listener = vi.fn();
    f.bridge.subscribe(listener);
    f.command("presentation", { visible: false, active: false });
    await flush();
    expect(f.bridge.presentation).toEqual({ visible: false, active: false });
    expect(listener).toHaveBeenCalledTimes(1);
    f.command("presentation", { visible: true, active: true }, { requestId: "show" });
    f.command("focus-composer", {}, { requestId: "focus" });
    await flush();
    expect(document.activeElement).toBe(document.querySelector("textarea"));
    expect(f.messages.at(-1)).toMatchObject({
      type: "command-result",
      requestId: "focus",
      ok: true,
    });
  });

  it("does not publish a late navigation result after document retirement", async () => {
    const f = fixture();
    const gate = createDeferred();
    f.navigateAndWait.mockReturnValue(gate.promise);
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
    await flush();
    f.bridge.dispose();
    gate.resolve();
    await flush();
    expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
  });
});
