// Shared theme resolution for the City, Lab and Editor pages.
//
// Each page also runs a tiny inline copy of this logic immediately inside
// <body> so the theme class lands before first paint. This module is the
// authority afterwards; the inline script only exists to avoid a flash.

export const THEME_KEY = "mt-theme";

// localStorage throws in some privacy modes; a missing preference is fine.
export function savedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

export function initialThemeIsDark() {
  const saved = savedTheme();
  if (saved === "dark") return true;
  if (saved === "light") return false;
  return systemPrefersDark();
}

// Only ever called from a toggle
export function storeTheme(isDark) {
  try {
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

// Live-follows the OS, but only while the user has made no explicit choice.
export function watchSystemTheme(onChange) {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const handler = (e) => {
    if (!savedTheme()) onChange(e.matches);
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
