/**
 * Title of the start screen ("Ready to get started?").
 *
 * The sentence changes on every opening of the app: the draw uses a module-scope
 * seed, evaluated once per process. Navigating between chat and code, switching
 * folders or reopening a conversation does not swap the text under the user.
 *
 * The choice depends on the MODE and on the learned NAME:
 * - chat: invitation and conversation; with a name, it greets ("Hello, Ana.").
 * - code: building and starting point ("What shall we build today?").
 *
 * Without a name, the variants with a name do not enter the draw — no "Hello, .".
 * The sentences are short on purpose: the title is `whitespace-nowrap` on the screen, and
 * a long sentence overflows the column instead of breaking the line.
 *
 * It lives in shared so the mobile app uses the same rule and so the draw is
 * testable without Electron.
 */

export type WelcomeTitleMode = 'chat' | 'code'

export interface WelcomeTitleInput {
  mode: WelcomeTitleMode
  /** Name learned in the conversation or typed in the Preferences. */
  userName?: string | null
  /** Local hour (0–23), for "Good morning/Good afternoon/Good evening". Default: now. */
  hour?: number
  /** 0..1. Only the tests pass it; in production the seed of the opening applies. */
  seed?: number
}

/** Invitation and conversation, without a name. */
const CHAT_PLAIN = [
  'chat.empty.startTitle',
  'chat.empty.titleHelloCasual',
  'chat.empty.titleHowAreYou',
  'chat.empty.titleWhatShallWeDo',
] as const

/** Chat with a name: the greeting is the first impression. The time-based one comes in the middle. */
const CHAT_NAMED = [
  'chat.empty.hello',
  'chat.empty.titleGoodToSee',
  'chat.empty.titleWhereStartName',
  'chat.empty.titleReadyName',
] as const

/** Code without a name: building and starting point. */
const CODE_PLAIN = [
  'chat.empty.startTitle',
  'chat.empty.titleWhatToBuild',
  'chat.empty.titleWhatToTackle',
  'chat.empty.titleWhatToWorkOn',
  'chat.empty.titleWhereStart',
  'chat.empty.titleFirstStep',
] as const

/**
 * Code with a name: the same ideas, without the "today" — the name takes space and the
 * title does not break the line.
 */
const CODE_NAMED = [
  'chat.empty.titleWhatToBuildName',
  'chat.empty.titleWhatToWorkOnName',
  'chat.empty.titleReadyName',
] as const

const DAY_GREETINGS = [
  'chat.empty.titleMorning',
  'chat.empty.titleAfternoon',
  'chat.empty.titleEvening',
] as const

/** All the keys the draw can return (the i18n test uses this list). */
export const WELCOME_TITLE_KEYS: readonly string[] = [
  ...new Set<string>([...CHAT_PLAIN, ...CHAT_NAMED, ...CODE_PLAIN, ...CODE_NAMED, ...DAY_GREETINGS]),
]

/** Seed of the opening: drawn once, when the module loads. */
const LAUNCH_SEED = Math.random()

/** "Good morning" until noon, "Good afternoon" until 6 pm, "Good evening" for the rest. */
function dayGreetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return DAY_GREETINGS[0]
  if (hour >= 12 && hour < 18) return DAY_GREETINGS[1]
  return DAY_GREETINGS[2]
}

function chatNamedPool(hour: number): readonly string[] {
  return [CHAT_NAMED[0], dayGreetingKey(hour), ...CHAT_NAMED.slice(1)]
}

/** Uniform index in [0, length), tolerant to a seed out of range. */
function indexFor(seed: number, length: number): number {
  const safe = Number.isFinite(seed) ? Math.min(Math.max(seed, 0), 0.999999) : 0
  return Math.floor(safe * length)
}

/**
 * Returns the i18n KEY of the title — the caller resolves it with `t(key, { name })`.
 * That way the translation stays where the others are, and the draw does not depend on the language.
 */
export function pickWelcomeTitle({ mode, userName, hour, seed }: WelcomeTitleInput): string {
  const hasName = Boolean(userName?.trim())
  const pool =
    mode === 'code'
      ? hasName
        ? CODE_NAMED
        : CODE_PLAIN
      : hasName
        ? chatNamedPool(hour ?? new Date().getHours())
        : CHAT_PLAIN
  return pool[indexFor(seed ?? LAUNCH_SEED, pool.length)] ?? CHAT_PLAIN[0]
}
