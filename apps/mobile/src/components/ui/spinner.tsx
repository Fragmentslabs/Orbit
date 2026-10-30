import { LoaderCircle } from 'lucide-react-native'
import { Spin } from './spin'

/**
 * Ring spinner with a missing piece (LoaderCircle spinning),
 * same visual identity as the desktop (animate-spin + LoaderCircle).
 */
export function Spinner({ size = 14, color }: { size?: number; color?: string }) {
  return (
    <Spin>
      <LoaderCircle size={size} color={color} />
    </Spin>
  );
}