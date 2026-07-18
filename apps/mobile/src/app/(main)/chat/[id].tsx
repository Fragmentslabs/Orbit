import { useLocalSearchParams } from 'expo-router'
import { ChatScreen } from '~/components/chat/ChatScreen'

export default function ChatRoute() {
  const { id } = useLocalSearchParams<{ id: string }>()
  return <ChatScreen sessionId={id} />
}
