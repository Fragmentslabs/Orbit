/**
 * Re-export of the `orbit-ui` blocks' contract, which now lives in shared so that the
 * mobile app draws the same components (the schema is the same in both).
 *
 * The file stays here so as not to touch the importers (`@/src/lib/orbit-ui`):
 * the desktop's public path remains the same.
 */
export * from "@shared/orbit-ui"
