import "./side-question.test-support.js";
import { describe, expect, it } from "vitest";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  createStoredCodexAppServerBinding,
  readCodexAppServerThreadBinding,
  sessionBindingIdentity,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

const {
  createFakeClient,
  getSharedCodexAppServerClientMock,
  readCodexAppServerBindingMock,
  runCodexAppServerSideQuestion,
  sideParams,
  useSideQuestionTestSetup,
} = await import("./side-question.test-support.js");
const { runCodexAppServerSideQuestion: runSideQuestionWithBindingStore } =
  await import("./side-question.js");

describe("Codex side-question app consent", () => {
  useSideQuestionTestSetup();

  it("preserves native app consent in yolo mode when apps are bound", async () => {
    const client = createFakeClient();
    const baseRequest = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      return baseRequest(method, params);
    });
    getSharedCodexAppServerClientMock.mockResolvedValue(client);
    readCodexAppServerBindingMock.mockReturnValue(
      readCodexAppServerThreadBinding({
        ...readCodexAppServerBindingMock(),
        pluginAppPolicyContext: {
          fingerprint: "native-app-consent",
          apps: {
            calendar: {
              source: "account",
              appName: "Calendar",
              allowDestructiveActions: true,
              destructiveApprovalMode: "auto",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      }),
    );

    await expect(
      runCodexAppServerSideQuestion(sideParams(), {
        pluginConfig: { appServer: { mode: "yolo" } },
      }),
    ).resolves.toEqual({ text: "Side answer." });

    const fork = client.request.mock.calls.find(([method]) => method === "thread/fork")?.[1];
    expect(fork).toMatchObject({
      approvalPolicy: {
        granular: {
          mcp_elicitations: true,
          rules: false,
          sandbox_approval: false,
          request_permissions: false,
          skill_approval: false,
        },
      },
    });
  });

  it("rejects an upgraded MCP-only binding before a side fork can bypass current plugin approval", async () => {
    const params = sideParams();
    const identity = sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.cfg,
    });
    const oldBinding = createStoredCodexAppServerBinding({
      ...readCodexAppServerBindingMock(),
      pluginAppPolicyContext: { fingerprint: "old-mcp-only", apps: {}, pluginAppIds: {} },
    });
    expect(oldBinding).toBeDefined();
    const state = createCodexTestBindingStateStore();
    state.register(bindingStoreKey(identity), oldBinding!);
    const bindingStore = createCodexAppServerBindingStore(state);
    expect(bindingStore.read(identity)?.pluginAppPolicyContext).toEqual({
      fingerprint: "old-mcp-only",
      apps: {},
      pluginAppIds: {},
    });

    await expect(
      runSideQuestionWithBindingStore(params, {
        bindingStore,
        pluginConfig: {
          appServer: { mode: "yolo" },
          codexPlugins: {
            enabled: true,
            plugins: { docs: { marketplaceName: "company-tools", pluginName: "docs" } },
          },
        },
      }),
    ).rejects.toThrow("Send a normal message to refresh plugin ownership");
    expect(getSharedCodexAppServerClientMock).not.toHaveBeenCalled();
  });
});
