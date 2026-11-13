import { cn } from "@/lib/utils"

/**
 * The team as an avatar group: the same faces in the list, in the floating card and in the
 * execution's card. Initials and a tint derived from the position — the app has no photo for
 * an agent, and a colored stack reads faster than a list of names.
 */
const TINTS = [
  "bg-amber-300",
  "bg-sky-300",
  "bg-emerald-300",
  "bg-rose-300",
  "bg-violet-300",
  "bg-teal-300",
]

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

export function agentTint(index: number): string {
  return TINTS[index % TINTS.length]
}

export function AgentAvatars({ names, size = 20, max = 4, ring = "border-card", className }: {
  names: string[]
  /** Diameter in pixels. */
  size?: number
  max?: number
  /** The ring that separates one avatar from the next — it has to match the surface behind. */
  ring?: string
  className?: string
}) {
  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      {names.slice(0, max).map((name, index) => (
        <span
          key={`${name}-${index}`}
          title={name}
          style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.34)) }}
          className={cn(
            "-ml-1.5 grid shrink-0 place-items-center rounded-full border-2 font-semibold text-zinc-900 first:ml-0",
            ring,
            agentTint(index),
          )}
        >
          {agentInitials(name)}
        </span>
      ))}
    </div>
  )
}
