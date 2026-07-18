import { View, Pressable } from 'react-native'
import { cn } from '~/lib/utils'

interface UserMessageNavItem {
  id: string
  text: string
}

interface UserMessageNavProps {
  items: UserMessageNavItem[]
  activeId: string | null
  onSelect: (id: string) => void
  planIds?: Set<string>
}

export function UserMessageNav({ items, activeId, onSelect, planIds }: UserMessageNavProps) {
  if (items.length < 2) return null

  return (
    <View className="absolute right-1 top-4 z-30 flex-col items-end gap-1.5">
      {items.map((item) => {
        const isPlan = planIds?.has(item.id)
        return (
          <Pressable
            key={item.id}
            onPress={() => onSelect(item.id)}
            className={cn(
              'rounded-full transition-all',
              isPlan && item.id === activeId
                ? 'h-1.5 w-5 bg-primary'
                : isPlan
                  ? 'h-1.5 w-2 bg-primary/60'
                  : item.id === activeId
                    ? 'h-1.5 w-5 bg-foreground'
                    : 'h-1.5 w-2 bg-muted-foreground/40',
            )}
          />
        )
      })}
    </View>
  )
}
