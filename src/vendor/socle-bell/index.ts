// Socle bell. Source: edwinder237/socle, packages/bell. Apps copy it with
// scripts/vendor.ts (into EisenQ's src/vendor/socle-bell/) and never edit
// their copy: changes go through Socle, and the copy's VERSION and
// SHA256SUMS say which Socle version and commit it is.
//
// What an app imports. No provider name appears in it.

export const SOCLE_BELL_VERSION = "1.0.1";

export { SocleBell, DEFAULT_LABELS } from "./SocleBell";
export type {
  BellAction,
  BellAppearance,
  BellColor,
  BellGroup,
  BellItem,
  BellLabels,
  BellReminders,
  BellTarget,
  SnoozeOption,
  SocleBellProps,
} from "./types";
