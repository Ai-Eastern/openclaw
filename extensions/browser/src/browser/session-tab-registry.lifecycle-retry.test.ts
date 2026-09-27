import { describe, expect, it, vi } from "vitest";
import { installSessionTabRegistrySqliteHarness } from "./session-tab-registry.sqlite.test-harness.js";
import { durableOwnership as ownership } from "./session-tab-registry.sqlite.test-helpers.js";

describe("session tab lifecycle cleanup", () => {
  const { freshRegistry, openStore } = installSessionTabRegistrySqliteHarness();

  it.each(["durable", "volatile"] as const)(
    "settles admitted %s cleanup but stops claiming tabs when its caller changes",
    async (kind) => {
      const registry = await freshRegistry(`caller-generation-${kind}`);
      const sessionKey = "agent:subagent:ended";
      for (const targetId of ["tab-a", "tab-b"]) {
        registry.trackSessionBrowserTab({
          sessionKey,
          targetId,
          profile: "remote",
          ...(kind === "durable"
            ? { ownership: ownership(targetId) }
            : { route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const }),
        });
      }
      let current = true;
      const closeTab = vi.fn(async (_tab: { targetId: string }) => {
        current = false;
      });
      const closeDurableTab: NonNullable<
        Parameters<typeof registry.closeTrackedBrowserTabsForSessions>[0]["closeDurableTab"]
      > = async (tab, options) => {
        await closeTab({ targetId: tab.nativeTargetId });
        expect(options.shouldClose()).toBe(true);
        return { status: "closed" };
      };
      const cleanupParams = { sessionKeys: [sessionKey], closeTab, closeDurableTab };
      await expect(
        registry.closeTrackedBrowserTabsForSessions({ ...cleanupParams, isCurrent: () => current }),
      ).resolves.toBe(1);
      expect(closeTab).toHaveBeenCalledOnce();
      if (kind === "durable") {
        expect(openStore().entries()).toHaveLength(1);
        expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
      }
      await expect(registry.closeTrackedBrowserTabsForSessions(cleanupParams)).resolves.toBe(1);
      expect(closeTab.mock.calls.map(([tab]) => tab.targetId).toSorted()).toEqual([
        "tab-a",
        "tab-b",
      ]);
      expect(openStore().entries()).toEqual([]);
    },
  );

  it.each([true, false])(
    "retries pending lifecycle cleanup with ordinary cleanup %s",
    async (ordinaryCleanup) => {
      const registry = await freshRegistry("lifecycle-retry");
      registry.trackSessionBrowserTab({
        sessionKey: "agent:subagent:ended",
        targetId: "opaque",
        profile: "remote",
        ownership: ownership("NATIVE-PENDING"),
        now: 1_000,
      });
      await expect(
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: ["agent:subagent:ended"],
          now: 2_000,
          closeDurableTab: async () => ({
            status: "unavailable",
            reason: "target-lookup-failed",
          }),
        }),
      ).resolves.toBe(0);
      expect(openStore().entries()[0]?.value).toMatchObject({
        nativeTargetId: "NATIVE-PENDING",
        cleanupKind: "lifecycle",
        cleanupAttemptToken: expect.any(String),
      });
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:active",
        targetId: "active",
        profile: "remote",
        ownership: ownership("NATIVE-ACTIVE"),
        now: 1_000,
      });

      await expect(
        registry.sweepTrackedBrowserTabs({
          now: 10_000,
          ordinaryCleanup,
          sessionFilter: () => false,
          closeDurableTab: async (_tab, options) =>
            options.shouldClose() ? { status: "closed" } : { status: "cancelled" },
        }),
      ).resolves.toBe(1);
      expect(
        openStore()
          .entries()
          .map((entry) => entry.value),
      ).toEqual([expect.objectContaining({ nativeTargetId: "NATIVE-ACTIVE" })]);
    },
  );
});
