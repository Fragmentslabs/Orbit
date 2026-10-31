/**
 * Ceilings of one `run_tools` run.
 *
 * They live together because they answer the same question — how far a script
 * written by the model may go before it costs the user something: time, context
 * or a wrong action.
 */

/** Wall-clock ceiling of the whole script (default and maximum). */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 300_000

/**
 * Ceiling for the SYNCHRONOUS slice of the script. The script runs on the main
 * process, so a `while (true)` would freeze the interface until the wall-clock
 * timeout — this is what interrupts it.
 */
export const SYNC_LIMIT_MS = 15_000

/** A script longer than this is a script that should have been a file. */
export const MAX_CODE_CHARS = 20_000

/** Tool calls inside one script. Above this, the script is a runaway loop. */
export const MAX_TOOL_CALLS = 200

/**
 * A run that used the bridge only a handful of times. Below this the run did not
 * pay for its round trip, and the result says so — the model reads that line while
 * deciding the NEXT step, which is where the tool description cannot reach it.
 */
export const SHALLOW_RUN_CALLS = 3

/**
 * What comes back to the model: the beginning and the end, as in `bash`. Keeping
 * only the beginning loses the summary/error that usually lands at the end.
 */
export const OUTPUT_HEAD = 6_000
export const OUTPUT_TAIL = 10_000

/** The value the script `return`s: what the model gets is what it asked for, capped. */
export const MAX_RETURN_CHARS = 12_000
