import { AppWindow } from "lucide-react"
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic"
import { FRAGMENT_DEFAULT_ICON } from "@shared/fragments"

const KNOWN = new Set<string>(iconNames)

/** Is this a lucide icon name we can draw? (The agent picks a name; it may guess wrong.) */
function isKnownIcon(name: string): name is IconName {
  return KNOWN.has(name)
}

/**
 * A fragment's icon, by lucide name. Loaded per icon (lucide's dynamic entry), so the
 * app does not carry the whole set just because a fragment may choose any of them; an
 * unknown name or one still loading shows the generic window icon.
 */
export function FragmentIcon({ name, className }: { name?: string; className?: string }) {
  const safe = name && isKnownIcon(name) ? name : FRAGMENT_DEFAULT_ICON
  return <DynamicIcon name={safe as IconName} className={className} fallback={() => <AppWindow className={className} />} />
}
