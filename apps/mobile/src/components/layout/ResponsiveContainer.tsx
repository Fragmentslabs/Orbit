import { useEffect } from 'react'
import { View, useWindowDimensions } from 'react-native'
import { cn } from '~/lib/utils'
import { getBreakpoint, type Breakpoint } from '~/lib/theme'

interface ResponsiveContainerProps {
  children: React.ReactNode
  className?: string
  /**
   * Maximum width for desktop layout
   * @default 'max-w-7xl'
   */
  maxWidth?: string
  /**
   * Whether to center content on larger screens
   * @default true
   */
  center?: boolean
  /**
   * Whether to add horizontal padding on mobile
   * @default true
   */
  mobilePadding?: boolean
  /**
   * Callback when breakpoint changes
   */
  onBreakpointChange?: (breakpoint: Breakpoint) => void
}

export function ResponsiveContainer({
  children,
  className,
  maxWidth = 'max-w-7xl',
  center = true,
  mobilePadding = true,
  onBreakpointChange,
}: ResponsiveContainerProps) {
  const { width } = useWindowDimensions()
  // Derivado direto da largura — não precisa de estado próprio
  const breakpoint = getBreakpoint(width)

  useEffect(() => {
    onBreakpointChange?.(breakpoint)
  }, [breakpoint, onBreakpointChange])

  return (
    <View
      className={cn(
        // Base styles
        'flex-1 bg-background',
        // Mobile padding
        mobilePadding && breakpoint === 'mobile' && 'px-4',
        // Centering and max-width for larger screens
        center && breakpoint !== 'mobile' && 'items-center',
        className
      )}
    >
      <View
        className={cn(
          // Full width on mobile
          'w-full',
          // Max width on larger screens
          breakpoint !== 'mobile' && maxWidth,
          // Centering
          center && breakpoint !== 'mobile' && 'mx-auto'
        )}
      >
        {children}
      </View>
    </View>
  )
}

// ============================================
// Responsive Hooks
// ============================================

/**
 * Hook to get current breakpoint
 */
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions()
  return getBreakpoint(width)
}

/**
 * Hook to check if current screen is mobile
 */
export function useIsMobile(): boolean {
  const breakpoint = useBreakpoint()
  return breakpoint === 'mobile'
}

/**
 * Hook to check if current screen is tablet or larger
 */
export function useIsTabletOrLarger(): boolean {
  const breakpoint = useBreakpoint()
  return breakpoint === 'tablet' || breakpoint === 'desktop'
}

/**
 * Hook to check if current screen is desktop
 */
export function useIsDesktop(): boolean {
  const breakpoint = useBreakpoint()
  return breakpoint === 'desktop'
}

// ============================================
// Responsive Grid
// ============================================

interface ResponsiveGridProps {
  children: React.ReactNode
  className?: string
  /**
   * Number of columns on mobile
   * @default 1
   */
  mobileColumns?: number
  /**
   * Number of columns on tablet
   * @default 2
   */
  tabletColumns?: number
  /**
   * Number of columns on desktop
   * @default 3
   */
  desktopColumns?: number
  /**
   * Gap between items
   * @default 'gap-4'
   */
  gap?: string
}

export function ResponsiveGrid({
  children,
  className,
  mobileColumns = 1,
  tabletColumns = 2,
  desktopColumns = 3,
  gap = 'gap-4',
}: ResponsiveGridProps) {
  const breakpoint = useBreakpoint()

  const columns =
    breakpoint === 'desktop'
      ? desktopColumns
      : breakpoint === 'tablet'
      ? tabletColumns
      : mobileColumns

  return (
    <View
      className={cn(
        'flex-row flex-wrap',
        gap,
        className
      )}
    >
      {Array.isArray(children)
        ? children.map((child, index) => (
            <View
              key={index}
              className={cn(
                // Calculate width based on columns
                columns === 1 && 'w-full',
                columns === 2 && 'w-1/2',
                columns === 3 && 'w-1/3',
                columns === 4 && 'w-1/4'
              )}
            >
              {child}
            </View>
          ))
        : children}
    </View>
  )
}

// ============================================
// Hide/Show at Breakpoint
// ============================================

interface VisibleAtProps {
  children: React.ReactNode
  /**
   * Breakpoints where children should be visible
   */
  breakpoints: Breakpoint[]
  /**
   * Whether to hide instead of show at specified breakpoints
   * @default false
   */
  hide?: boolean
}

export function VisibleAt({ children, breakpoints, hide = false }: VisibleAtProps) {
  const currentBreakpoint = useBreakpoint()
  const isVisible = breakpoints.includes(currentBreakpoint)

  if (hide ? !isVisible : isVisible) {
    return <>{children}</>
  }

  return null
}