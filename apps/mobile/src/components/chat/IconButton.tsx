/**
 * The standard square of the message actions (copy, listen, reply, revert).
 *
 * 21×21 = 13 icon + 4 of breathing room on each side. It exists because the alignment
 * of the bar cannot depend on the intrinsic size of what is inside: the
 * activity indicator of the "generating" state measures 20px, and with `padding` it
 * stretched the button (28×28), pushing the whole row and taking the icon off the
 * optical line of the others.
 *
 * With a fixed box and centered content, the four actions stay on the same axis
 * in ANY state — including while the voice is being generated.
 */
import type { ReactNode } from 'react'
import { Pressable } from 'react-native'

/** Side of the square. A single number for all the actions: it is what aligns them. */
export const ICON_BUTTON_SIZE = 21

interface IconButtonProps {
  onPress: () => void
  accessibilityLabel?: string
  accessibilityState?: { busy?: boolean }
  testID?: string
  children: ReactNode
}

export function IconButton({
  onPress,
  accessibilityLabel,
  accessibilityState,
  testID,
  children,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      testID={testID}
      style={({ pressed }) => ({
        width: ICON_BUTTON_SIZE,
        height: ICON_BUTTON_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {children}
    </Pressable>
  )
}
