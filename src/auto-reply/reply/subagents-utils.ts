// Shared subagent helpers for routing, labels, and transcript text.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry-read.js";
import { sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { truncateUtf16Safe } from "../../utils.js";

export function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  return normalizeOptionalString(entry.label) ?? normalizeOptionalString(entry.task) ?? fallback;
}

export function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = sanitizeTaskStatusText(resolveSubagentLabel(entry)) || "subagent";
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return raw;
  }
  return raw.length > maxLength ? `${truncateUtf16Safe(raw, maxLength).trimEnd()}…` : raw;
}
