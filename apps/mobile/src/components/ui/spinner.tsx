import { LoaderCircle } from 'lucide-react-native'
import { Spin } from './spin'

/**
 * Spinner de anel com um pedaço faltando (LoaderCircle girando),
 * mesma identidade visual do desktop (animate-spin + LoaderCircle).
 */
export function Spinner({ size = 14, color }: { size?: number; color?: string }) {
  return (
    <Spin>
      <LoaderCircle size={size} color={color} />
    </Spin>
  );
}