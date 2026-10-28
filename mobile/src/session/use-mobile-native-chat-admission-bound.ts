import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS } from './mobile-native-chat-delivery-evidence'
import {
  markMobileNativeChatPendingUnconfirmed,
  type MobileNativeChatPendingMessage
} from './mobile-native-chat-pending-echo'

type SetPending = Dispatch<SetStateAction<Record<string, MobileNativeChatPendingMessage[]>>>

/** Arms one timer per accepted bubble that marks it unconfirmed if no transcript echo retired it
 *  first. Each timer ends when it fires or the screen unmounts, so cost follows live bubbles. */
export function usePendingAdmissionBound(
  ...setters: readonly SetPending[]
): (pendingId: string) => void {
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const settersRef = useRef(setters)
  settersRef.current = setters
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])
  return useCallback((pendingId: string) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      for (const setPending of settersRef.current) {
        setPending((previous) => markMobileNativeChatPendingUnconfirmed(previous, pendingId))
      }
    }, MOBILE_NATIVE_CHAT_ADMISSION_BOUND_MS)
    timersRef.current.add(timer)
  }, [])
}
