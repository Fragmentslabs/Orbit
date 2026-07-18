import type { LucideIcon } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { cn } from '~/lib/utils'

interface ModeToggleProps {
  icon: LucideIcon
  label: string
  description: string
  active: boolean
  onToggle: () => void
  disabled?: boolean
}

export function ModeToggle({
  icon: Icon,
  label,
  active,
  onToggle,
  disabled,
}: ModeToggleProps) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      className={cn(
        'flex-row items-center gap-1 rounded-md px-1.5 py-1',
        active
          ? 'bg-muted'
          : 'opacity-40',
        disabled && 'opacity-20',
      )}
    >
      <Icon
        size={14}
        className={active ? 'text-foreground' : 'text-muted-foreground'}
      />
      <Text
        className={cn(
          'text-xs',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </Text>
    </Pressable>
  )
}
