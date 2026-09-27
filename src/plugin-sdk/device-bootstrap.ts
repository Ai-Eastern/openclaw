// Shared bootstrap/pairing helpers for plugins that provision remote devices.

export { approveDevicePairing } from "../infra/device-pairing-approval.js";
export { listDevicePairing } from "../infra/device-pairing.js";
export {
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
export {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
  type DeviceBootstrapPurpose,
} from "../shared/device-bootstrap-profile.js";

/** Resolve the advertised pairing endpoint without issuing credentials or loading setup at startup. */
export async function resolvePairingGatewayUrl(
  ...args: Parameters<typeof import("../pairing/setup-code.js").resolvePairingGatewayUrl>
) {
  const pairing = await import("../pairing/setup-code.js");
  return await pairing.resolvePairingGatewayUrl(...args);
}
