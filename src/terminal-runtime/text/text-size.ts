import { lineWidth } from "@/terminal-runtime/text/width-memo.js";

type Output = {
  width: number;
  height: number;
};

function calculateTextDimensions(text: string, maxWidth: number): Output {
  if (text.length === 0) {
    return {
      width: 0,
      height: 0,
    };
  }

  const noWrap = maxWidth <= 0 || !Number.isFinite(maxWidth);

  let height = 0;
  let width = 0;
  let start = 0;

  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = end === -1 ? text.substring(start) : text.substring(start, end);

    const w = lineWidth(line);
    width = Math.max(width, w);

    if (noWrap) {
      height++;
    } else {
      height += w === 0 ? 1 : Math.ceil(w / maxWidth);
    }

    if (end === -1) break;
    start = end + 1;
  }

  return { width, height };
}

export default calculateTextDimensions;
