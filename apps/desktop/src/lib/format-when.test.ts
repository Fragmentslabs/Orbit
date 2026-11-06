import { describe, expect, it } from "vitest"
import { formatHourOfDay, formatWhen } from "./format"

// A Friday, in the middle of the day so no timezone moves it across midnight.
const NOW = new Date(2026, 10, 6, 14, 30).getTime()
const at = (month: number, day: number, hour: number, minute = 0, year = 2026) =>
  new Date(year, month, day, hour, minute).getTime()

describe("formatWhen", () => {
  it("says today and tomorrow with the words of the language, and the time in 24h in Portuguese", () => {
    expect(formatWhen(at(10, 6, 17, 30), "pt-BR", NOW)).toBe("hoje, 17:30")
    expect(formatWhen(at(10, 7, 9), "pt-BR", NOW)).toBe("amanhã, 09:00")
    expect(formatWhen(at(10, 5, 8), "pt-BR", NOW)).toBe("ontem, 08:00")
  })

  it("uses AM and PM in English", () => {
    expect(formatWhen(at(10, 6, 17, 30), "en", NOW)).toBe("today, 05:30 PM")
    expect(formatWhen(at(10, 7, 9), "en", NOW)).toBe("tomorrow, 09:00 AM")
  })

  it("names the day further away, with the year only when it is another year", () => {
    expect(formatWhen(at(10, 10, 10), "en", NOW)).toBe("Nov 10, 10:00 AM")
    expect(formatWhen(at(0, 2, 10, 0, 2027), "en", NOW)).toBe("Jan 2, 2027, 10:00 AM")
  })
})

describe("formatHourOfDay", () => {
  it("labels the grid with 00:00 in Portuguese and AM/PM in English", () => {
    expect(formatHourOfDay(7, "pt-BR")).toBe("07:00")
    expect(formatHourOfDay(19, "pt-BR")).toBe("19:00")
    expect(formatHourOfDay(7, "en")).toBe("07:00 AM")
    expect(formatHourOfDay(19, "en")).toBe("07:00 PM")
  })
})
