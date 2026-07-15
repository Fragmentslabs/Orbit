import { View, Text, Pressable } from 'react-native'
import { Shield, HelpCircle } from 'lucide-react-native'
import type { PendingAsk } from '~/stores/chat-store'

interface AskCardProps {
  ask: PendingAsk
  onReply: (value: unknown) => void
}

export function AskCard({ ask, onReply }: AskCardProps) {
  const isPermission = ask.kind === 'permission'

  return (
    <View className="mx-4 my-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      {/* Header */}
      <View className="flex-row items-center gap-2 mb-2">
        {isPermission ? (
          <Shield size={14} className="text-amber-500" />
        ) : (
          <HelpCircle size={14} className="text-amber-500" />
        )}
        <Text className="text-xs font-semibold text-amber-500 uppercase">
          {isPermission ? 'Permissão necessária' : 'Pergunta'}
        </Text>
      </View>

      {/* Questions */}
      {ask.questions?.map((q, i) => (
        <Text key={i} className="text-sm text-foreground mb-1">
          {q.text}
        </Text>
      ))}

      {ask.claim ? (
        <Text className="text-xs text-muted-foreground mb-2" numberOfLines={2}>
          {ask.claim.detail ?? ask.claim.title}
        </Text>
      ) : null}

      {/* Quick actions */}
      <View className="flex-row gap-2 mt-2">
        {isPermission ? (
          <>
            <Pressable
              onPress={() => onReply({ approved: false })}
              className="flex-1 py-2 rounded-md bg-destructive/10 border border-destructive/20 items-center"
            >
              <Text className="text-xs text-destructive text-center font-medium">
                Rejeitar
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onReply({ approved: true })}
              className="flex-1 py-2 rounded-md bg-green-500/10 border border-green-500/20 items-center"
            >
              <Text className="text-xs text-green-500 text-center font-medium">
                Aprovar
              </Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={() => onReply({ acknowledged: true })}
            className="flex-1 py-2 rounded-md bg-primary/10 border border-primary/20 items-center"
          >
            <Text className="text-xs text-primary text-center font-medium">
              Entendido
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  )
}
