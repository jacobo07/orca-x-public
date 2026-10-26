import type { PermissionResponse } from 'expo-modules-core'
import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'

export class ExpoTwoWayAudioUnavailableError extends Error {
  constructor() {
    super('Dictation is not available in this app build (native audio module missing).')
    this.name = 'ExpoTwoWayAudioUnavailableError'
  }
}

export function isExpoTwoWayAudioAvailable(): boolean {
  return ExpoTwoWayAudioModule != null
}

export function nativeTwoWayAudio() {
  if (ExpoTwoWayAudioModule == null) {
    throw new ExpoTwoWayAudioUnavailableError()
  }
  return ExpoTwoWayAudioModule
}

export async function initialize() {
  return await nativeTwoWayAudio().initialize()
}

export function playPCMData(audioData: Uint8Array) {
  return nativeTwoWayAudio().playPCMData(audioData)
}

export function bypassVoiceProcessing(bypass: boolean) {
  return nativeTwoWayAudio().bypassVoiceProcessing(bypass)
}

export function toggleRecording(val: boolean): boolean {
  return nativeTwoWayAudio().toggleRecording(val)
}

export function isRecording(): boolean {
  return nativeTwoWayAudio().isRecording()
}

export function tearDown() {
  return nativeTwoWayAudio().tearDown()
}

export function restart() {
  return nativeTwoWayAudio().restart()
}

export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return nativeTwoWayAudio().getMicrophonePermissionsAsync()
}

export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return nativeTwoWayAudio().requestMicrophonePermissionsAsync()
}

export function getMicrophoneModeIOS() {
  return nativeTwoWayAudio().getMicrophoneModeIOS()
}

export function setMicrophoneModeIOS() {
  return nativeTwoWayAudio().setMicrophoneModeIOS()
}

export function isPlaying(): boolean {
  return nativeTwoWayAudio().isPlaying()
}

export function stopPlayback() {
  return nativeTwoWayAudio().stopPlayback()
}

export function pausePlayback() {
  return nativeTwoWayAudio().pausePlayback()
}

export function resumePlayback() {
  return nativeTwoWayAudio().resumePlayback()
}
