import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import { assertOutboundHandoffCurrent } from "../../infra/outbound/deliver-handoff.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import {
  agentRuntimeClientForTests as agentRuntimeClient,
  directCliClientForTests as directCliClient,
  firstRespondCall,
} from "./send.test-helpers.js";
import {
  type createMessageMethodPluginFixtures,
  type createMessageMethodTestDriver,
  makeContext,
} from "./send.test-support.js";
import type { GatewayRequestContext } from "./types.js";

type UploadPolicyTestHarness = Pick<
  ReturnType<typeof createMessageMethodTestDriver>,
  "runSendWithClient" | "runMessageActionRequest"
> &
  Pick<ReturnType<typeof createMessageMethodPluginFixtures>, "registerMessageActionPlugin"> & {
    mocks: {
      deliverOutboundPayloads: Mock<typeof deliverOutboundPayloads>;
      dispatchChannelMessageAction: Mock<typeof dispatchChannelMessageAction>;
    };
    mockDeliverySuccess: (messageId: string) => void;
  };

// Register in the existing send suite so all shared setup and test ordering stay intact.
export function registerSendUploadPolicyTests({
  mocks,
  runSendWithClient,
  runMessageActionRequest,
  registerMessageActionPlugin,
  mockDeliverySuccess,
}: UploadPolicyTestHarness): void {
  describe.each(["send", "message.action"] as const)("%s client upload commit policy", (method) => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    const bytes = "client upload commit fixture";

    function uploadFixture() {
      const stateDir = tempDirs.make("gateway-send-upload-policy-");
      const env = captureEnv(["OPENCLAW_STATE_DIR"]);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      let enabled = true;
      const context = {
        ...makeContext(),
        // The admitted snapshot deliberately stays enabled after the committed policy changes.
        getRuntimeConfig: () => ({ gateway: { uploads: { enabled: true } } }),
        getCommittedRuntimeConfig: () => ({ gateway: { uploads: { enabled } } }),
      } as GatewayRequestContext;
      const plugin = registerMessageActionPlugin({
        id: "slack",
        registrySuffix: "client-upload-policy",
      });
      const invoke = (options: { trusted?: boolean; mediaUrl?: string } = {}) => {
        const sessionKey = "agent:main:slack:channel:C1";
        const client = options.trusted
          ? agentRuntimeClient(sessionKey)
          : { connect: { ...directCliClient().connect, scopes: ["operator.write"] } };
        const content = options.mediaUrl
          ? { mediaUrl: options.mediaUrl }
          : {
              buffer: Buffer.from(bytes).toString("base64"),
              filename: "upload.txt",
              contentType: "text/plain",
            };
        const common = {
          channel: "slack",
          agentId: "main",
          ...(options.trusted ? { sessionKey } : {}),
          idempotencyKey: "client-upload-policy",
        };
        return method === "send"
          ? runSendWithClient({ ...common, to: "channel:C1", ...content }, client, context)
          : runMessageActionRequest(
              { ...common, action: "send", params: { to: "channel:C1", ...content } },
              client,
              context,
            );
      };
      return {
        plugin,
        invoke,
        outboundDir: path.join(stateDir, "media", "outbound"),
        disable: () => {
          enabled = false;
        },
        restore: () => env.restore(),
      };
    }

    it.each([
      { disable: false, trusted: false },
      { disable: true, trusted: false },
      { disable: true, trusted: true },
    ])(
      "checks policy after media directory preparation (disabled: $disable, trusted: $trusted)",
      async ({ disable, trusted }) => {
        const fixture = uploadFixture();
        const prepared = createDeferred();
        const release = createDeferred();
        let preparing = false;
        const originalMkdir = fs.mkdir;
        // This await belongs to saveMediaBuffer on both the original and repaired paths.
        // Native fs-safe publication need not call the JavaScript fs.open implementation.
        const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
          const result = await originalMkdir(...args);
          if (!preparing && args[0] === fixture.outboundDir) {
            preparing = true;
            prepared.resolve();
            await release.promise;
          }
          return result;
        });
        mockDeliverySuccess("upload-accepted");
        const request = fixture.invoke({ trusted });
        try {
          await Promise.race([prepared.promise, request]);
          expect(preparing).toBe(true);
          if (disable) {
            fixture.disable();
          }
          release.resolve();
          const { respond } = await request;
          const denied = disable && !trusted;
          expect(firstRespondCall(respond)[0]).toBe(!denied);
          if (denied) {
            expect(firstRespondCall(respond)[2]).toMatchObject({
              code: ErrorCodes.FORBIDDEN,
              details: { code: "UPLOADS_DISABLED" },
            });
            expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
            expect(mocks.dispatchChannelMessageAction).not.toHaveBeenCalled();
            expect(await fs.readdir(fixture.outboundDir)).toEqual([]);
          } else {
            const files = await fs.readdir(fixture.outboundDir);
            expect(files).toHaveLength(1);
            await expect(
              fs.readFile(path.join(fixture.outboundDir, files[0]!), "utf8"),
            ).resolves.toBe(bytes);
          }
        } finally {
          release.resolve();
          try {
            await request;
          } finally {
            mkdirSpy.mockRestore();
            fixture.restore();
          }
        }
      },
    );

    it.each([
      { boundary: "dispatch", trusted: false, accepted: false, reference: false },
      { boundary: "handoff", trusted: false, accepted: false, reference: false },
      { boundary: "handoff", trusted: true, accepted: false, reference: false },
      { boundary: "handoff", trusted: false, accepted: true, reference: false },
      { boundary: "handoff", trusted: false, accepted: false, reference: true },
    ] as const)(
      "retains ingress classification at $boundary (trusted: $trusted, accepted: $accepted, reference: $reference)",
      async ({ boundary, trusted, accepted, reference }) => {
        const fixture = uploadFixture();
        const entered = createDeferred();
        const release = createDeferred();
        const platformSend = vi.fn();
        let prepared = false;
        const send = async (params: {
          onPlatformSendDispatch?: () => Promise<void>;
          assertDirectAdapterHandoff?: () => void;
        }) => {
          if (boundary === "handoff") {
            await params.onPlatformSendDispatch?.();
          }
          if (accepted) {
            assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
            platformSend();
          }
          prepared = true;
          entered.resolve();
          await release.promise;
          if (!accepted) {
            if (boundary === "dispatch") {
              await params.onPlatformSendDispatch?.();
            }
            assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
            platformSend();
          }
        };
        if (method === "message.action") {
          const { dispatchChannelMessageAction } = await vi.importActual<
            typeof import("../../channels/plugins/message-action-dispatch.js")
          >("../../channels/plugins/message-action-dispatch.js");
          mocks.dispatchChannelMessageAction.mockImplementationOnce(dispatchChannelMessageAction);
          const actions = expectDefined(fixture.plugin.actions, "upload action adapter");
          actions.handleAction = async (ctx) => {
            expect(ctx.params).not.toHaveProperty("buffer");
            await send(ctx);
            return jsonResult({ ok: true, messageId: "upload-accepted" });
          };
        } else {
          mocks.deliverOutboundPayloads.mockImplementationOnce(async (params) => {
            await send(params);
            return [{ channel: "slack", messageId: "upload-accepted" }];
          });
        }
        const request = fixture.invoke({
          trusted,
          ...(reference ? { mediaUrl: "https://example.com/already-hosted.png" } : {}),
        });
        try {
          await Promise.race([entered.promise, request]);
          expect(prepared).toBe(true);
          if (!reference) {
            const files = await fs.readdir(fixture.outboundDir);
            expect(files).toHaveLength(1);
            await expect(
              fs.readFile(path.join(fixture.outboundDir, files[0]!), "utf8"),
            ).resolves.toBe(bytes);
          }
          fixture.disable();
          release.resolve();
          const { respond } = await request;
          const allowed = trusted || accepted || reference;
          expect(firstRespondCall(respond)[0]).toBe(allowed);
          expect(platformSend).toHaveBeenCalledTimes(allowed ? 1 : 0);
          if (!allowed) {
            expect(firstRespondCall(respond)[2]).toMatchObject({
              code: ErrorCodes.FORBIDDEN,
              details: { code: "UPLOADS_DISABLED" },
            });
          }
        } finally {
          release.resolve();
          try {
            await request;
          } finally {
            fixture.restore();
          }
        }
      },
    );
  });
}
