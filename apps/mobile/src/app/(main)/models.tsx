import { View, Text, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Box, ArrowLeft } from 'lucide-react-native'
import { EmptyState } from '~/components/layout/EmptyState'

export default function ModelsScreen() {
  const router = useRouter()

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} className="p-1 -ml-1">
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <Text className="flex-1 text-base font-semibold text-foreground text-center mr-6">
          Modelos
        </Text>
      </View>
      <ScrollView className="flex-1">
        <EmptyState
          icon={Box}
          title="Modelos"
          description="O catálogo de modelos aparecerá aqui."
        />
      </ScrollView>
    </SafeAreaView>
  )
}
