import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { installNativeEmbed } from "./native-nav.test-support.ts";

const suite = createChatFlowE2eSuite();
const viewport = { width: 1180, height: 820 };
type ConversationTestWindow = Window &
  typeof globalThis & {
    conversationMessages: Record<string, unknown>[];
    __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__: { documentId: string };
  };
const messages = (page: Page) =>
  page.evaluate(() => (window as ConversationTestWindow).conversationMessages);
async function command(page: Page, type: string, payload: unknown, requestId: string) {
  await page.evaluate(
    (commandDetails) => {
      const host = window as ConversationTestWindow;
      window.dispatchEvent(
        new CustomEvent("openclaw:native-conversation-command", {
          detail: {
            contract: 1,
            documentId: host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"].documentId,
            ...commandDetails,
          },
        }),
      );
    },
    { type, payload, requestId },
  );
  await expect
    .poll(async () =>
      (await messages(page)).find(
        (message) => message.type === "command-result" && message.requestId === requestId,
      ),
    )
    .toMatchObject({ ok: true });
}

async function headerLeadingInset(page: Page) {
  return page.locator(".chat-pane-cache__pane--visible .chat-pane__header").evaluate((header) => {
    const leading = header.querySelector(".chat-pane__header-leading");
    if (!leading) {
      throw new Error("Chat header leading region is missing");
    }
    return leading.getBoundingClientRect().left - header.getBoundingClientRect().left;
  });
}

suite.define(() => {
  it("keeps a single web conversation with in-page native navigation and Dashboard handoff", async () => {
    await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
      await page.addInitScript(() => {
        Object.assign(window, {
          __OPENCLAW_NATIVE_EMBED__: {
            platform: "macos",
            formFactor: "desktop",
            surface: "conversation",
          },
          __OPENCLAW_NATIVE_CONVERSATION__: { contract: 1 },
          conversationMessages: [],
          webkit: {
            messageHandlers: {
              openclawConversation: {
                postMessage(message: Record<string, unknown>) {
                  (window as ConversationTestWindow).conversationMessages.push(message);
                  return Promise.resolve({ ok: true });
                },
              },
            },
          },
        });
      });
      const linkedUrl = controlUiSessionUrl(suite.server.baseUrl, "agent:main:linked");
      const gateway = await installMockGateway(page, {
        sessions: ["main", "next", "linked"].map((name) => ({
          key: `agent:main:${name}`,
          label: name,
          kind: "direct",
        })),
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Conversation ready. [Linked conversation](${linkedUrl}) · [Settings](/settings?section=general)`,
              },
            ],
          },
        ],
      });
      await page.addInitScript((storageKey) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            chatSplitLayout: {
              columns: [
                {
                  id: "c1",
                  panes: [{ id: "p1", sessionKey: "agent:main:main" }],
                  paneWeights: [1],
                },
                {
                  id: "c2",
                  panes: [{ id: "p2", sessionKey: "agent:main:extra" }],
                  paneWeights: [1],
                },
              ],
              columnWeights: [0.5, 0.5],
              activePaneId: "p2",
            },
          }),
        );
      }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const pane = page.locator(".chat-pane-cache__pane--visible");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor();
      await pane.getByText("Conversation ready.", { exact: false }).waitFor();
      expect(
        await page
          .locator(
            "openclaw-app-sidebar, openclaw-app-topbar, .shell-nav, .native-embed-header, .settings-sidebar__agent",
          )
          .count(),
      ).toBe(0);
      expect(await page.locator(".chat-split-view__cell").count()).toBe(1);
      expect(await pane.locator(".chat-pane__header").isVisible()).toBe(true);
      expect(await pane.locator(".chat-thread").isVisible()).toBe(true);
      expect(await headerLeadingInset(page)).toBe(12);
      const first = (await messages(page))[0];
      expect(first).toMatchObject({ type: "ready", contract: 1, surface: "conversation" });
      const documentId = first?.documentId;
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      if (captureUiProofEnabled) {
        await mkdir(".artifacts/pr-proof", { recursive: true });
        await page.screenshot({ path: ".artifacts/pr-proof/conversation-initial.png" });
      }
      await composer.fill("Verify the web composer");
      await pane.getByRole("button", { name: "Send message", exact: true }).click();
      const request = requireRecord((await gateway.waitForRequest("chat.send")).params);
      expect(request.message).toBe("Verify the web composer");
      expect(request.sessionKey).toBe("agent:main:main");
      await gateway.emitChatFinal({
        runId: requireString(request.idempotencyKey, "run id"),
        text: "Web composer verified.",
      });
      await pane
        .locator(".chat-thread-inner")
        .getByText("Web composer verified.", { exact: true })
        .waitFor();
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:next" },
        "navigate-1",
      );
      await expect
        .poll(async () => (await messages(page)).findLast((message) => message.type === "state"))
        .toMatchObject({ context: { agentId: "main", sessionKey: "agent:main:next" } });
      const navigationMessages = await messages(page);
      const navigationResult = navigationMessages.findIndex(
        (message) => message.type === "command-result" && message.requestId === "navigate-1",
      );
      const targetState = navigationMessages.findIndex(
        (message) =>
          message.type === "state" &&
          requireRecord(message.context).sessionKey === "agent:main:next",
      );
      expect(targetState).toBeGreaterThan(-1);
      expect(targetState).toBeLessThan(navigationResult);
      await pane.getByRole("link", { name: "Linked conversation", exact: true }).click();
      await expect
        .poll(async () =>
          (await messages(page)).findLast((message) => message.type === "route-changed"),
        )
        .toMatchObject({ agentId: "main", sessionKey: "agent:main:linked" });
      const conversationUrl = page.url();
      await pane.getByRole("link", { name: "Settings", exact: true }).click();
      await expect
        .poll(async () =>
          (await messages(page)).findLast((message) => message.type === "open-dashboard"),
        )
        .toMatchObject({ path: "/settings", search: "?section=general" });
      expect(page.url()).toBe(conversationUrl);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect((await messages(page)).every((message) => message.documentId === documentId)).toBe(
        true,
      );
      await command(page, "presentation", { visible: false, active: false }, "hide");
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("true");
      await command(
        page,
        "navigate",
        { agentId: "main", sessionKey: "agent:main:next" },
        "hidden-navigate",
      );
      await command(page, "presentation", { visible: true, active: true }, "show");
      await expect.poll(() => pane.getAttribute("aria-hidden")).toBe("false");
      await command(page, "focus-composer", {}, "focus");
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await headerLeadingInset(page)).toBe(12);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: ".artifacts/pr-proof/conversation-navigated.png" });
      }
    });
  });

  it.each(["browser", "ios"] as const)(
    "preserves %s chat and settings presentation",
    async (mode) => {
      await suite.withPage({ viewport, serviceWorkers: "block" }, async ({ page }) => {
        if (mode === "ios") {
          await installNativeEmbed(page, { platform: "ios", formFactor: "pad" });
        }
        await installMockGateway(page, {
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Ordinary conversation." }] },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await page.locator(".chat-pane__header").isVisible()).toBe(true);
        expect(await page.locator(".native-embed-header").count()).toBe(mode === "ios" ? 1 : 0);
        expect(await page.locator(".settings-sidebar__agent").count()).toBe(mode === "ios" ? 1 : 0);
        expect(
          await page.evaluate(() => "__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__" in window),
        ).toBe(false);
        if (mode === "ios") {
          await page.locator(".native-embed-header__back").click();
          await page
            .locator(".native-embed-header")
            .getByText("Settings", { exact: true })
            .waitFor();
          expect(new URL(page.url()).pathname).toBe("/settings");
        } else {
          expect(await headerLeadingInset(page)).toBe(12);
          expect(await page.locator("openclaw-app-sidebar").isVisible()).toBe(true);
        }
      });
    },
  );
});
