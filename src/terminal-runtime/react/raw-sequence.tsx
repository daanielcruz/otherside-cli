import React from "react";

type Props = {
  lines: string[];

  width: number;
};

export function RawSequence({ lines, width }: Props): React.ReactNode {
  if (lines.length === 0) {
    return null;
  }
  return <ink-raw-ansi rawText={lines.join("\n")} rawWidth={width} rawHeight={lines.length} />;
}
