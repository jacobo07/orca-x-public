export const DEVICE_REGISTRY_FILENAME = 'orca-devices.json'
// Why: kept out of the devices file so an older build still reads orca-devices.json as a bare array.
export const DEVICE_REVOCATIONS_FILENAME = 'orca-device-revocations.json'
export const E2EE_KEYPAIR_FILENAME = 'orca-e2ee-keypair.json'

// Migrate these together so device tokens and E2EE material never split across dirs.
export const MOBILE_PAIRING_USERDATA_FILES = [
  DEVICE_REGISTRY_FILENAME,
  E2EE_KEYPAIR_FILENAME
] as const
