import type * as React from "react";
import { ShellLayout, type ShellLayoutProps } from "@/ui/chrome/layout/shell.tsx";

export type ChromeShellProps = ShellLayoutProps;

export function ChromeShell(props: ChromeShellProps): React.JSX.Element {
  return <ShellLayout {...props} />;
}
