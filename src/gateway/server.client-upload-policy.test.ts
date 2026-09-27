// Real RPC owners and media filesystem; only inference uses the shared Gateway fixture.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMediaDir } from "../media/store.js";
import { agentHandlers } from "./server-methods/agent.js";
import { handleDirectExternalChatSend } from "./server-methods/chat-send-external-entry.js";
import { sessionCreateHandlers } from "./server-methods/sessions-create.js";
import { sessionMessagingHandlers } from "./server-methods/sessions-messaging.js";
import type { GatewayRequestHandler, RespondFn } from "./server-methods/types.js";
import {
  installAgentAuthorityProofFixture,
  PNG,
} from "./server.agent-runtime-authority-proof.test-support.js";
import { agentCommandMock, dispatchInboundMessageMock } from "./test-helpers.js";

const handlers: Record<string, GatewayRequestHandler> = {
  "chat.send": handleDirectExternalChatSend,
  agent: agentHandlers.agent!,
  "sessions.send": sessionMessagingHandlers["sessions.send"]!,
  "sessions.create": sessionCreateHandlers["sessions.create"]!,
};

describe("client upload policy at the input commit owner", () => {
  const fixture = installAgentAuthorityProofFixture();

  it.each([
    ["chat.send", "inline-image"],
    ["chat.send", "offloaded-image"],
    ["chat.send", "document"],
    ["agent", "inline-image"],
    ["agent", "offloaded-image"],
    ["sessions.send", "inline-image"],
    ["sessions.create", "document"],
  ] as const)(
    "rejects %s %s disabled while the real media writer awaits mkdir",
    async (method, kind) => {
      const f = await fixture({ imageCapable: true });
      const originalCommittedConfig = f.context.getCommittedRuntimeConfig;
      const initialConfig = f.context.getRuntimeConfig();
      let committedConfig: OpenClawConfig = {
        ...initialConfig,
        gateway: { ...initialConfig.gateway, uploads: { enabled: true } },
      };
      f.context.getCommittedRuntimeConfig = () => committedConfig;
      const mediaDir = path.join(getMediaDir(), "inbound");
      const before = await fs.readdir(mediaDir).catch(() => [] as string[]);
      const entered = createDeferred();
      const resume = createDeferred();
      const mkdir = fs.mkdir.bind(fs);
      let intercepted = false;
      const pause = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const result = await mkdir(...args);
        if (!intercepted && String(args[0]) === mediaDir) {
          intercepted = true;
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const respond = vi.fn<RespondFn>();
      const content =
        kind === "document"
          ? Buffer.from("late upload policy proof")
          : Buffer.concat([
              Buffer.from(PNG, "base64"),
              Buffer.alloc(kind === "offloaded-image" ? 2_000_001 : 0),
            ]);
      const requestParams = {
        agentId: "main",
        ...(method === "sessions.create"
          ? { key: `agent:main:upload-create:${f.runId}` }
          : method === "sessions.send"
            ? { key: f.sessionKey }
            : { sessionKey: f.sessionKey }),
        message: "Inspect this attachment",
        ...(method === "sessions.create" ? {} : { idempotencyKey: f.runId }),
        attachments: [
          {
            mimeType: kind === "document" ? "text/plain" : "image/png",
            fileName: kind === "document" ? "proof.txt" : "proof.png",
            content: content.toString("base64"),
          },
        ],
      };
      const pending = Promise.resolve(
        handlers[method]!({
          req: { type: "req", id: f.runId, method, params: requestParams },
          params: requestParams,
          client: {
            connId: "upload-policy-proof",
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              role: "operator",
              scopes: ["operator.admin"],
              client: { id: "cli", mode: "cli", platform: "test", version: "test" },
            },
          },
          context: f.context,
          respond,
          isWebchatConnect: () => false,
        }),
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("handler finished before entering the media writer");
          }),
        ]);
        committedConfig = {
          ...committedConfig,
          gateway: { ...committedConfig.gateway, uploads: { enabled: false } },
        };
        resume.resolve();
        await pending;
        await f.drain();
        expect(intercepted).toBe(true);
        if (method === "sessions.create") {
          // Creation remains committed; only its initial input is rejected.
          expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
            runStarted: false,
            runError: { code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } },
          });
        } else {
          expect(respond.mock.calls.some(([ok]) => ok)).toBe(false);
          expect(respond.mock.calls.at(-1)?.[2]).toMatchObject({
            code: "FORBIDDEN",
            details: { code: "UPLOADS_DISABLED" },
          });
        }
        expect(await fs.readdir(mediaDir)).toEqual(before);
        expect(agentCommandMock).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        resume.resolve();
        await Promise.allSettled([pending]);
        pause.mockRestore();
        f.context.getCommittedRuntimeConfig = originalCommittedConfig;
        await f.cleanup();
      }
    },
  );
});
