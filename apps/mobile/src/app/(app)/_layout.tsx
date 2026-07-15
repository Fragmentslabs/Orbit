import { Tabs } from 'expo-router'
import { MessageCircle, FolderOpen, Settings } from 'lucide-react-native'

export default function AppLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: 'hsl(217, 91%, 60%)',
        tabBarInactiveTintColor: 'hsl(240, 4%, 46%)',
        tabBarStyle: {
          backgroundColor: 'hsl(240, 10%, 4%)',
          borderTopColor: 'hsl(240, 4%, 16%)',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chat',
          tabBarIcon: ({ color, size }) => (
            <MessageCircle size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: 'Sessões',
          tabBarIcon: ({ color, size }) => (
            <FolderOpen size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Config',
          tabBarIcon: ({ color, size }) => (
            <Settings size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  )
}
