import type { ConfigValidationIssue } from "../../config/types.js";

export function failedGatewayRunConfigSnapshot(
  issues: ConfigValidationIssue[] = [{ path: "<root>", message: "JSON5 parse failed" }],
) {
  return {
    exists: true,
    valid: false,
    path: "/tmp/openclaw-test-missing-config.json",
    config: {},
    sourceConfig: {},
    parsed: null,
    issues,
    legacyIssues: [],
  };
}
