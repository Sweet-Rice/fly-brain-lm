import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'flybrain-theme';

interface ThemeChoice {
  explicit: boolean;
  theme: Theme;
}

function storedTheme(): Theme | null {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null;
  }
}

function initialTheme(): ThemeChoice {
  const stored = storedTheme();
  return {
    explicit: stored !== null,
    theme:
      stored ??
      (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'),
  };
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = choice.theme;
    document.documentElement.style.colorScheme = choice.theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        choice.theme === 'dark' ? '#101714' : '#f4f0e7',
      );

    if (choice.explicit) {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, choice.theme);
      } catch {
        // Theme still applies when browser storage is unavailable.
      }
      return;
    }

    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    const followSystem = (event: MediaQueryListEvent) => {
      setChoice({ explicit: false, theme: event.matches ? 'dark' : 'light' });
    };
    media?.addEventListener('change', followSystem);
    return () => media?.removeEventListener('change', followSystem);
  }, [choice]);

  return {
    theme: choice.theme,
    toggleTheme: () =>
      setChoice((current) => ({
        explicit: true,
        theme: current.theme === 'dark' ? 'light' : 'dark',
      })),
  };
}
