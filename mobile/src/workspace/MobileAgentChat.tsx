import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import type { AgentGrounding } from '../../../src/shared/agent-grounding'
import type { ConversationLoadResult } from '../../../src/shared/conversation-types'
import { colors } from '../theme/mobile-theme'
import {
  describeMobileGrounding,
  describeMobileTurnOutcome,
  latestThreadForAgent,
  sendMobileAgentMessage
} from './mobile-workspace-client'
import { projectLabel } from './MobileWorkspaceRoster'
import { useMobileWorkspace } from './use-mobile-workspace'

type Line = { key: string; role: 'user' | 'assistant'; text: string }

function linesOf(read: ConversationLoadResult | null): Line[] {
  if (!read || read.outcome !== 'loaded') {
    return []
  }
  return read.record.messages.flatMap((message, index) => {
    const text = message.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim()
    return text && (message.role === 'user' || message.role === 'assistant')
      ? [{ key: `${index}`, role: message.role, text }]
      : []
  })
}

/** One agent's thread on the phone — the same record the desktop reads, grounded in the same project. */
export function MobileAgentChat({ hostId, agentId }: { hostId: string; agentId: string }) {
  const router = useRouter()
  const { load, client, connected } = useMobileWorkspace(hostId)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [read, setRead] = useState<ConversationLoadResult | null>(null)
  const [grounding, setGrounding] = useState<AgentGrounding | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const row =
    load.kind === 'ready' ? (load.agents.find((a) => a.agent.id === agentId) ?? null) : null

  const readThread = useCallback(
    async (id: string) => {
      if (!client) {
        return
      }
      const response = await client.sendRequest('conversations.read', { id })
      setRead(response.ok ? (response.result as ConversationLoadResult) : null)
    },
    [client]
  )

  useEffect(() => {
    if (load.kind !== 'ready' || !client) {
      return
    }
    const latest = latestThreadForAgent(load.threads, agentId)
    setConversationId(latest)
    if (latest) {
      void readThread(latest)
    }
    void client.sendRequest('conversations.agentGrounding', { agentId }).then((response) => {
      setGrounding(response.ok ? (response.result as AgentGrounding) : null)
    })
  }, [load, client, agentId, readThread])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!client || !text || sending) {
      return
    }
    setSending(true)
    setNotice(null)
    const result = await sendMobileAgentMessage(client, { agentId, conversationId, text })
    setSending(false)
    if (result.kind === 'error') {
      setNotice(result.message)
      return
    }
    if (result.kind === 'not-created') {
      setNotice(describeMobileTurnOutcome(result.outcome).text)
      return
    }
    setDraft('')
    setConversationId(result.conversationId)
    await readThread(result.conversationId)
    if (result.outcome !== 'completed') {
      setNotice(describeMobileTurnOutcome(result.outcome).text)
    }
  }, [client, draft, sending, agentId, conversationId, readThread])

  const grounded = grounding ? describeMobileGrounding(grounding) : null
  const lines = linesOf(read)
  const cannotSend = !connected || sending || draft.trim().length === 0

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.iconButton}
        >
          <ChevronLeft size={20} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.headerBody}>
          <Text style={styles.title} numberOfLines={1} testID="agent-chat-name">
            {row?.agent.name ?? 'Agent'}
          </Text>
          {row ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {projectLabel(row.project)}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.context} testID="agent-chat-context">
        <Text style={styles.contextTerm}>Next turn</Text>
        <Text style={styles.contextValue}>{grounded ? grounded.location : 'Reading…'}</Text>
        {grounded?.credential ? (
          <>
            <Text style={styles.contextTerm}>Provider</Text>
            <Text style={styles.contextValue}>{grounded.credential}</Text>
          </>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.thread} testID="agent-chat-thread">
          {load.kind === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
          {load.kind !== 'loading' && lines.length === 0 ? (
            <Text style={styles.empty}>No messages yet. Your first message starts a thread.</Text>
          ) : null}
          {lines.map((line) => (
            <View
              key={line.key}
              style={[styles.bubble, line.role === 'user' ? styles.userBubble : styles.agentBubble]}
            >
              <Text style={styles.bubbleText}>{line.text}</Text>
            </View>
          ))}
        </ScrollView>
        {notice ? (
          <Text style={styles.notice} accessibilityLiveRegion="polite" testID="agent-chat-notice">
            {notice}
          </Text>
        ) : null}
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            multiline
            style={styles.input}
            accessibilityLabel="Message"
            testID="agent-chat-input"
          />
          <Pressable
            onPress={() => void send()}
            disabled={cannotSend}
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: cannotSend, busy: sending }}
            style={[styles.send, cannotSend && styles.sendDisabled]}
            testID="agent-chat-send"
          >
            {sending ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerBody: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  context: {
    margin: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  contextTerm: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  contextValue: { color: colors.textPrimary, fontSize: 13, marginTop: 2 },
  body: { flex: 1 },
  thread: { padding: 12, gap: 8 },
  empty: { color: colors.textSecondary, fontSize: 14, padding: 12 },
  bubble: { maxWidth: '86%', padding: 10, borderRadius: 12 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: colors.bgRaised },
  agentBubble: { alignSelf: 'flex-start', backgroundColor: colors.bgPanel },
  bubbleText: { color: colors.textPrimary, fontSize: 14, lineHeight: 20 },
  notice: { color: colors.textSecondary, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    fontSize: 15
  },
  send: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentBlue
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.onAccent, fontSize: 15, fontWeight: '600' }
})
