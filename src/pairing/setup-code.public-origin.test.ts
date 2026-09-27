import { describe, expect, it, vi } from "vitest";
import { resolvePairingGatewayUrl } from "./setup-code.js";

const options = { env: {}, networkInterfaces: () => ({}) };

describe("pairing public origin", () => {
  it.each([
    ["https://gateway.example.test", "wss://gateway.example.test"],
    ["http://127.0.0.1:19821", "ws://127.0.0.1:19821"],
    ["https://gateway.example.test/openclaw-gw", "wss://gateway.example.test/openclaw-gw"],
  ])("normalizes gateway.publicOrigin %s", async (publicOrigin, url) => {
    await expect(
      resolvePairingGatewayUrl({ gateway: { bind: "loopback", publicOrigin } }, options),
    ).resolves.toEqual({ url, source: "gateway.publicOrigin" });
  });

  it.each(["serve", "funnel"] as const)(
    "prefers public ingress over automatic remote URLs and Tailscale %s",
    async (mode) => {
      const config = {
        gateway: {
          bind: "loopback",
          publicOrigin: "https://gateway.example.test",
          remote: { url: "wss://remote.example.test" },
          tailscale: { mode },
        },
      } satisfies Parameters<typeof resolvePairingGatewayUrl>[0];
      const runCommandWithTimeout = vi.fn();
      const resolveOptions = { ...options, runCommandWithTimeout };
      await expect(resolvePairingGatewayUrl(config, resolveOptions)).resolves.toEqual({
        url: "wss://gateway.example.test",
        source: "gateway.publicOrigin",
      });
      await expect(
        resolvePairingGatewayUrl(config, {
          ...resolveOptions,
          preferRemoteUrl: true,
          publicUrl: "https://pairing.example.test",
        }),
      ).resolves.toEqual({
        url: "wss://pairing.example.test",
        source: "plugins.entries.device-pair.config.publicUrl",
      });
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      preferRemoteUrl: undefined,
      url: "wss://gateway.example.test",
      source: "gateway.publicOrigin",
    },
    {
      preferRemoteUrl: true,
      url: "wss://remote.example.test",
      source: "gateway.remote.url",
    },
  ])(
    "selects $source when preferRemoteUrl=$preferRemoteUrl",
    async ({ preferRemoteUrl, url, source }) => {
      await expect(
        resolvePairingGatewayUrl(
          {
            gateway: {
              publicOrigin: "https://gateway.example.test",
              remote: { url: "wss://remote.example.test" },
            },
          },
          { ...options, preferRemoteUrl },
        ),
      ).resolves.toEqual({ url, source });
    },
  );

  it("rejects an invalid publicOrigin before bind fallback", async () => {
    await expect(
      resolvePairingGatewayUrl(
        {
          gateway: {
            bind: "custom",
            customBindHost: "127.0.0.1",
            publicOrigin: "https://gateway.example.test:notaport",
          },
        },
        options,
      ),
    ).resolves.toEqual({ error: "Configured gateway.publicOrigin is invalid." });
  });
});
