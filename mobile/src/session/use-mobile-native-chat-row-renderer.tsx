import { useCallback, type RefObject } from 'react'
import type { FlatList } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingDelivery } from './mobile-native-chat-delivery-evidence'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

/** The chat list's row renderer, stable across renders that change none of its inputs. */
export function useMobileNativeChatRowRenderer(args: {
  listRef: RefObject<FlatList<NativeChatMessage> | null>
  deliveryByMessageId: Record<string, MobileNativeChatPendingDelivery>
  status: MobileNativeChatStatus
  toolsExpanded: boolean
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): ({ item, index }: { item: NativeChatMessage; index: number }) => React.JSX.Element {
  const { listRef, deliveryByMessageId, status, toolsExpanded, fontScale, onOpenFile } = args
  // Align a single message's top to the top of the viewport.
  const onScrollToMessage = useCallback(
    (index: number) => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
    },
    [listRef]
  )
  return useCallback(
    ({ item, index }: { item: NativeChatMessage; index: number }) => (
      <MobileNativeChatMessage
        message={item}
        delivery={deliveryByMessageId[item.id]}
        // Why: without a transcript feed a missing echo is the phone's blind spot, not the agent's.
        transcriptReadable={status === 'ready'}
        toolsExpanded={toolsExpanded}
        fontScale={fontScale}
        messageIndex={index}
        onScrollToMessage={onScrollToMessage}
        onOpenFile={onOpenFile}
      />
    ),
    [deliveryByMessageId, status, toolsExpanded, fontScale, onScrollToMessage, onOpenFile]
  )
}
