import { csi } from "@/terminal-runtime/terminal/control-sequences.js";
import type { TextStyle } from "@/terminal-runtime/terminal/protocol-contracts.js";
import {
  createDefaultStyle,
  NAMED_COLORS,
  UNDERLINE_STYLES,
} from "@/terminal-runtime/terminal/protocol-contracts.js";

export function sgr(...codes: number[]): string {
  return csi(...codes, "m");
}

type CodeParam = { value: number | null; subparams: number[]; colon: boolean };

function parseCodeParams(input: string): CodeParam[] {
  if (input === "") return [{ value: 0, subparams: [], colon: false }];

  const result: CodeParam[] = [];
  let current: CodeParam = { value: null, subparams: [], colon: false };
  let digits = "";
  let readingSubparameter = false;

  for (let index = 0; index <= input.length; index++) {
    const character = input[index];
    if (character === ";" || character === undefined) {
      const value = digits === "" ? null : parseInt(digits, 10);
      if (readingSubparameter) {
        if (value !== null) current.subparams.push(value);
      } else {
        current.value = value;
      }
      result.push(current);
      current = { value: null, subparams: [], colon: false };
      digits = "";
      readingSubparameter = false;
    } else if (character === ":") {
      const value = digits === "" ? null : parseInt(digits, 10);
      if (!readingSubparameter) {
        current.value = value;
        current.colon = true;
        readingSubparameter = true;
      } else if (value !== null) {
        current.subparams.push(value);
      }
      digits = "";
    } else if (character >= "0" && character <= "9") {
      digits += character;
    }
  }
  return result;
}

function parseExtendedRGB(
  params: CodeParam[],
  index: number,
): { r: number; g: number; b: number } | { index: number } | null {
  const parameter = params[index];
  if (!parameter) return null;

  if (parameter.colon && parameter.subparams.length >= 1) {
    if (parameter.subparams[0] === 5 && parameter.subparams.length >= 2) {
      return { index: parameter.subparams[1]! };
    }
    if (parameter.subparams[0] === 2 && parameter.subparams.length >= 4) {
      const componentOffset = parameter.subparams.length >= 5 ? 1 : 0;
      return {
        r: parameter.subparams[1 + componentOffset]!,
        g: parameter.subparams[2 + componentOffset]!,
        b: parameter.subparams[3 + componentOffset]!,
      };
    }
  }

  const nextParameter = params[index + 1];
  if (!nextParameter) return null;
  const indexedColor = params[index + 2]?.value;
  if (nextParameter.value === 5 && indexedColor !== null && indexedColor !== undefined) {
    return { index: indexedColor };
  }
  if (nextParameter.value === 2) {
    const red = params[index + 2]?.value;
    const green = params[index + 3]?.value;
    const blue = params[index + 4]?.value;
    if (
      red !== null &&
      red !== undefined &&
      green !== null &&
      green !== undefined &&
      blue !== null &&
      blue !== undefined
    ) {
      return { r: red, g: green, b: blue };
    }
  }
  return null;
}

export function applyRenderCodes(paramStr: string, style: TextStyle): TextStyle {
  const params = parseCodeParams(paramStr);
  let nextStyle = { ...style };
  let parameterIndex = 0;

  while (parameterIndex < params.length) {
    const parameter = params[parameterIndex]!;
    const code = parameter.value ?? 0;

    if (code === 0) {
      nextStyle = createDefaultStyle();
      parameterIndex++;
      continue;
    }
    if (code === 1) {
      nextStyle.bold = true;
      parameterIndex++;
      continue;
    }
    if (code === 2) {
      nextStyle.dim = true;
      parameterIndex++;
      continue;
    }
    if (code === 3) {
      nextStyle.italic = true;
      parameterIndex++;
      continue;
    }
    if (code === 4) {
      nextStyle.underline = parameter.colon
        ? (UNDERLINE_STYLES[parameter.subparams[0]!] ?? "single")
        : "single";
      parameterIndex++;
      continue;
    }
    if (code === 5 || code === 6) {
      nextStyle.blink = true;
      parameterIndex++;
      continue;
    }
    if (code === 7) {
      nextStyle.inverse = true;
      parameterIndex++;
      continue;
    }
    if (code === 8) {
      nextStyle.hidden = true;
      parameterIndex++;
      continue;
    }
    if (code === 9) {
      nextStyle.strikethrough = true;
      parameterIndex++;
      continue;
    }
    if (code === 21) {
      nextStyle.underline = "double";
      parameterIndex++;
      continue;
    }
    if (code === 22) {
      nextStyle.bold = false;
      nextStyle.dim = false;
      parameterIndex++;
      continue;
    }
    if (code === 23) {
      nextStyle.italic = false;
      parameterIndex++;
      continue;
    }
    if (code === 24) {
      nextStyle.underline = "none";
      parameterIndex++;
      continue;
    }
    if (code === 25) {
      nextStyle.blink = false;
      parameterIndex++;
      continue;
    }
    if (code === 27) {
      nextStyle.inverse = false;
      parameterIndex++;
      continue;
    }
    if (code === 28) {
      nextStyle.hidden = false;
      parameterIndex++;
      continue;
    }
    if (code === 29) {
      nextStyle.strikethrough = false;
      parameterIndex++;
      continue;
    }
    if (code === 53) {
      nextStyle.overline = true;
      parameterIndex++;
      continue;
    }
    if (code === 55) {
      nextStyle.overline = false;
      parameterIndex++;
      continue;
    }

    if (code >= 30 && code <= 37) {
      nextStyle.fg = { type: "named", name: NAMED_COLORS[code - 30]! };
      parameterIndex++;
      continue;
    }
    if (code === 39) {
      nextStyle.fg = { type: "default" };
      parameterIndex++;
      continue;
    }
    if (code >= 40 && code <= 47) {
      nextStyle.bg = { type: "named", name: NAMED_COLORS[code - 40]! };
      parameterIndex++;
      continue;
    }
    if (code === 49) {
      nextStyle.bg = { type: "default" };
      parameterIndex++;
      continue;
    }
    if (code >= 90 && code <= 97) {
      nextStyle.fg = { type: "named", name: NAMED_COLORS[code - 90 + 8]! };
      parameterIndex++;
      continue;
    }
    if (code >= 100 && code <= 107) {
      nextStyle.bg = { type: "named", name: NAMED_COLORS[code - 100 + 8]! };
      parameterIndex++;
      continue;
    }

    if (code === 38) {
      const parsedColor = parseExtendedRGB(params, parameterIndex);
      if (parsedColor) {
        nextStyle.fg =
          "index" in parsedColor
            ? { type: "indexed", index: parsedColor.index }
            : { type: "rgb", ...parsedColor };
        parameterIndex += parameter.colon ? 1 : "index" in parsedColor ? 3 : 5;
        continue;
      }
    }
    if (code === 48) {
      const parsedColor = parseExtendedRGB(params, parameterIndex);
      if (parsedColor) {
        nextStyle.bg =
          "index" in parsedColor
            ? { type: "indexed", index: parsedColor.index }
            : { type: "rgb", ...parsedColor };
        parameterIndex += parameter.colon ? 1 : "index" in parsedColor ? 3 : 5;
        continue;
      }
    }
    if (code === 58) {
      const parsedColor = parseExtendedRGB(params, parameterIndex);
      if (parsedColor) {
        nextStyle.underlineColor =
          "index" in parsedColor
            ? { type: "indexed", index: parsedColor.index }
            : { type: "rgb", ...parsedColor };
        parameterIndex += parameter.colon ? 1 : "index" in parsedColor ? 3 : 5;
        continue;
      }
    }
    if (code === 59) {
      nextStyle.underlineColor = { type: "default" };
      parameterIndex++;
      continue;
    }

    parameterIndex++;
  }
  return nextStyle;
}
