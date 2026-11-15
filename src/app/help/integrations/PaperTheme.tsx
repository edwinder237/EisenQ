"use client";

import { useEffect } from "react";

// The help page wears the dashboard's look: the paper ground, and dark mode
// from the same saved choice (or the system setting when there is none).
export function PaperTheme() {
  useEffect(() => {
    const body = document.body;
    body.classList.add("paper");
    body.classList.remove("bg-gray-950", "text-white");

    let stored: string | null = null;
    try {
      stored = localStorage.getItem("eisenq-dark-mode");
    } catch {
      /* storage blocked: follow the system */
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", stored !== null ? stored === "true" : media.matches);
    apply();
    media.addEventListener("change", apply);

    return () => {
      media.removeEventListener("change", apply);
      body.classList.remove("paper");
      body.classList.add("bg-gray-950", "text-white");
    };
  }, []);
  return null;
}
