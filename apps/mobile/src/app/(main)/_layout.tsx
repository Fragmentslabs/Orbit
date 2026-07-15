import { View } from 'react-native'
import { Stack } from 'expo-router'
import { Sidebar } from '~/components/layout/Sidebar'

export default function MainLayout() {
  return (
    <View className="flex-1 bg-background">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="memories" />
        <Stack.Screen name="models" />
        <Stack.Screen name="usage" />
        <Stack.Screen name="tools" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="theme" />
      </Stack>
      <Sidebar />
    </View>
  )
}
