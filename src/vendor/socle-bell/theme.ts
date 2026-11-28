// Socle bell. Source: edwinder237/socle, packages/bell. Don't edit a copy.
//
// The bell's look, as CSS variables set on its root, its row menu and its
// toast (those two are drawn outside the root). Each defaults to the variable
// EisenQ already defines, so EisenQ passes nothing.

import type { CSSProperties } from "react";
import type { BellAppearance, BellColor } from "./types";

export const DEFAULT_COLORS: Readonly<Record<BellColor, string>> = {
  ink: "var(--ink)",
  ink2: "var(--ink2)",
  ink3: "var(--ink3)",
  muted: "var(--muted)",
  muted3: "var(--muted3)",
  accent: "var(--accent)",
  accentText: "var(--btn-fg)",
  background: "var(--bg)",
  drawer: "var(--drawer)",
  drawerBorder: "var(--drawer-bd)",
  line: "var(--line2)",
  chip: "var(--chip)",
  hover: "var(--hover)",
  overlay: "var(--overlay)",
  doFirst: "var(--q-do-first)",
  schedule: "var(--q-schedule)",
  delegate: "var(--q-delegate)",
  eliminate: "var(--q-eliminate)",
};

// "--sb-<name>" for each colour.
export const v = (name: BellColor): string => `var(--sb-${name})`;

export function themeStyle(appearance: BellAppearance | undefined): CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, fallback] of Object.entries(DEFAULT_COLORS)) {
    style[`--sb-${name}`] = appearance?.colors?.[name as BellColor] ?? fallback;
  }
  style["--sb-title-font"] = appearance?.titleFontFamily ?? "var(--font-serif)";
  style["--sb-radius"] = appearance?.radius ?? "16px";
  if (appearance?.fontFamily) style.fontFamily = appearance.fontFamily;
  return style as CSSProperties;
}
