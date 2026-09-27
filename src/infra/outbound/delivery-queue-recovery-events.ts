import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import { buildPayloadSummary } from "./deliver-payload.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { createMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export function emitRecoveredMessageSentEvents(
  entry: QueuedDelivery,
  events: readonly MessageSentEvent[],
): void {
  const { emitMessageSent } = createMessageSentEmitter({
    hookRunner: getGlobalHookRunner(),
    channel: entry.channel,
    to: entry.to,
    accountId: entry.accountId,
    sessionKeyForInternalHooks: entry.mirror?.sessionKey ?? entry.session?.key,
    isGroup: entry.mirror?.isGroup,
    groupId: entry.mirror?.groupId,
    runId: entry.preparedBatch.runId,
    logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
  });
  for (const event of events) {
    emitMessageSent(event);
  }
}

export type IndexedMessageSentEvent = {
  sourceIndex: number;
  event: MessageSentEvent;
};

function queuedTerminalFailureEvents(
  entry: QueuedDelivery,
  error: string,
): IndexedMessageSentEvent[] {
  return acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => {
    const summary = buildPayloadSummary(prepared.payload);
    return {
      sourceIndex: prepared.sourceIndex,
      event: {
        success: false,
        content: summary.hookContent ?? summary.text,
        error,
      },
    };
  });
}

export function emitRecoveredTerminalFailure(
  entry: QueuedDelivery,
  error: string,
  collected: readonly IndexedMessageSentEvent[] = [],
): void {
  if (entry.legacyPreparedContentUnavailable) {
    return;
  }
  const fallbackEvents = queuedTerminalFailureEvents(entry, error);
  // Rendering can suppress an accepted payload before later payloads settle.
  // Reconcile by source index so a gap cannot duplicate or misattribute events.
  const collectedBySourceIndex = new Map(
    collected.map(({ sourceIndex, event }) => [sourceIndex, event] as const),
  );
  const terminalEvents = fallbackEvents.map(
    ({ sourceIndex, event }) => collectedBySourceIndex.get(sourceIndex) ?? event,
  );
  emitRecoveredMessageSentEvents(entry, terminalEvents);
}

export function emitRecoveredTerminalSuccess(
  entry: QueuedDelivery,
  result: OutboundDeliveryResult,
): void {
  if (entry.legacyPreparedContentUnavailable) {
    return;
  }
  const preparedEntries = acceptedPreparedOutboundEntries(entry.preparedBatch);
  if (preparedEntries.length === 0) {
    return;
  }
  const receiptMessageIds = result.receipt?.parts.length
    ? result.receipt.parts
        .toSorted((left, right) => left.index - right.index)
        .map((part) => part.platformMessageId)
    : result.receipt?.platformMessageIds;
  const messageIds =
    preparedEntries.length === 1
      ? [result.messageId || receiptMessageIds?.[0]]
      : receiptMessageIds?.length === preparedEntries.length
        ? receiptMessageIds
        : [];
  emitRecoveredMessageSentEvents(
    entry,
    preparedEntries.map((prepared, index) => {
      const summary = buildPayloadSummary(prepared.payload);
      const messageId = messageIds[index];
      const event: MessageSentEvent = {
        success: true,
        content: summary.hookContent ?? summary.text,
      };
      if (messageId) {
        event.messageId = messageId;
      }
      return event;
    }),
  );
}
