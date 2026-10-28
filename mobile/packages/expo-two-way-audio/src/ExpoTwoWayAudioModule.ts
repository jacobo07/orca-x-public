import { requireOptionalNativeModule } from 'expo-modules-core'

// Why: optional, not required — a binary built without this module must lose dictation, not crash
// every route that imports it (requireNativeModule throws at import time).
export default requireOptionalNativeModule('ExpoTwoWayAudio')
