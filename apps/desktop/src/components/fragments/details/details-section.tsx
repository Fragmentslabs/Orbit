import type { ReactNode } from "react"

/** A titled block of the details panel. */
export function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-1.5 text-xs">{children}</div>
    </section>
  )
}

/** One label/value line. */
export function DetailRow({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {value !== undefined && <span className="min-w-0 truncate text-right text-foreground">{value}</span>}
    </div>
  )
}
