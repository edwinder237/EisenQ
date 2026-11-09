import { useLayoutEffect } from "react";

// Puts a standalone page (the capture form, the extension's connect page) on the
// same "Calm Editorial" footing as the dashboard: the paper background and the
// .dark token theme, chosen the same way — the stored "eisenq-dark-mode" choice,
// else the system preference. Mirrors the dashboard's own theme effects.
//
// localStorage is per origin, so a choice saved on eisenq.app isn't visible on
// www.eisenq.app; there the system preference decides.
export function useEditorialTheme() {
  useLayoutEffect(() => {
    const body = document.body;
    body.classList.add("paper");
    body.classList.remove("bg-gray-950", "text-white");

    let stored: string | null = null;
    try {
      stored = localStorage.getItem("eisenq-dark-mode");
    } catch {
      /* storage blocked: fall back to the system preference */
    }
    const dark =
      stored !== null ? stored === "true" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const html = document.documentElement;
    html.classList.toggle("dark", dark);
    // Tells the browser the page already handles its own theme. Without it,
    // Chrome's automatic dark mode repaints the page (light cards, invisible
    // text), and native controls like the date picker ignore the theme.
    html.style.colorScheme = dark ? "dark" : "light";

    return () => {
      body.classList.remove("paper");
      body.classList.add("bg-gray-950", "text-white");
      html.style.colorScheme = "";
    };
  }, []);
}
