import { useEffect, useState } from "react";
import { useStdin } from "@/ink";
import { resolveThemeSetting } from "@/ui/theme/system-theme.ts";
import { setActiveTheme, subscribeTheme, type ThemeSetting } from "@/ui/theme/theme.ts";
import { watchSystemTheme } from "@/ui/theme/theme-watch.ts";

export function useThemeBootstrap(themePref: ThemeSetting | undefined): void {
  const [, setThemeVersion] = useState(0);
  const { internal_querier: querier } = useStdin();

  useEffect(() => {
    const initial = themePref ?? "auto";
    setActiveTheme(resolveThemeSetting(initial));
    const unsub = subscribeTheme(() => setThemeVersion((v) => v + 1));
    return () => {
      unsub();
    };
  }, [themePref]);

  useEffect(() => {
    if (!querier || (themePref ?? "auto") !== "auto") return;
    return watchSystemTheme(querier, (systemTheme) => setActiveTheme(systemTheme));
  }, [querier, themePref]);
}
