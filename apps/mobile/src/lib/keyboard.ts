import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Breathing room between the input and the gesture bar of the device when the keyboard is
 * CLOSED. It is a fixed padding of the input — never animated.
 *
 * What animates is only the KeyboardAvoidingView, and it receives this same value as a
 * NEGATIVE `keyboardVerticalOffset`, which makes its calculation become
 * `padding = keyboardHeight - breathingRoom`. Adding the fixed breathing room of the input:
 * closed, the breathing room is left; open, the input touches the keyboard; and in the middle of the
 * transition there is a single animation.
 *
 * The previous version animated the breathing room from the outside (interpolating the `progress` of the
 * keyboard): it worked at the extremes, but the `progress` of the KAV and the one of the public
 * hook come from different handlers — the two animations went out of phase by
 * a few pixels and the input overshot and came back.
 *
 * The floor of 8 exists because a device without a gesture bar reports inset 0, and then
 * the input would touch the edge of the screen.
 */
export function useBottomBreathing(): number {
  const insets = useSafeAreaInsets()
  return Math.max(insets.bottom, 8)
}
