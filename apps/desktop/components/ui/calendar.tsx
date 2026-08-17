import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

/**
 * Calendar sobre react-day-picker v10, seguindo o padrão shadcn. Adaptado ao
 * visual compacto do app (células size-7, textos menores). As classes de
 * seleção/estado caem no `<td>` do dia; o botão fica dentro preenchendo a
 * célula.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col gap-4 sm:flex-row sm:gap-8",
        month: "flex flex-col gap-3",
        month_caption: "relative flex items-center justify-center pt-1",
        caption_label: "text-xs font-medium",
        nav: "flex items-center gap-1",
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "absolute left-0 size-6 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "absolute right-0 size-6 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "w-7 rounded-md text-[0.65rem] font-normal text-muted-foreground",
        week: "mt-1.5 flex w-full",
        day: cn(
          "relative p-0 text-center text-xs focus-within:relative focus-within:z-20 [&[aria-selected]]:bg-accent [&[data-outside][aria-selected]]:bg-accent/50",
          props.mode === "range"
            ? "[&.range_end]:rounded-r-md [&.range_start]:rounded-l-md first:[&[aria-selected]]:rounded-l-md last:[&[aria-selected]]:rounded-r-md"
            : "[&[aria-selected]]:rounded-md",
        ),
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-7 p-0 font-normal aria-selected:opacity-100",
        ),
        range_start: "range_start",
        range_end: "range_end",
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground",
        outside:
          "text-muted-foreground [&[aria-selected]]:bg-accent/50 [&[aria-selected]]:text-muted-foreground",
        disabled: "text-muted-foreground opacity-50",
        range_middle:
          "[&[aria-selected]]:bg-accent [&[aria-selected]]:text-accent-foreground",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ className, orientation, ...props }) =>
          orientation === "left" ? (
            <ChevronLeft className={cn("size-3.5", className)} {...props} />
          ) : (
            <ChevronRight className={cn("size-3.5", className)} {...props} />
          ),
      }}
      {...props}
    />
  )
}

export { Calendar }
