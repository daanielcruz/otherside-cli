import { readFileSync } from "node:fs";
import codeExcerpt, { type CodeExcerpt } from "code-excerpt";
import StackUtils from "stack-utils";
import FlexContainer from "@/terminal-runtime/react/flex-container.js";
import StyledText from "@/terminal-runtime/react/styled-text.js";

const MAX_CODE_EXCERPT_LINE_LENGTH = 200;

const normalizeFilePath = (path: string | undefined): string | undefined => {
  return path?.replace(`file://${process.cwd()}/`, "");
};

function isInternalFrame(path: string): boolean {
  return (
    path.includes("$bunfs") ||
    path.includes("~BUN") ||
    path.includes("/snapshot/") ||
    path.startsWith("node:")
  );
}

function hasLongExcerptLine(excerpt: CodeExcerpt[]): boolean {
  return excerpt.some(({ value }) => value.length > MAX_CODE_EXCERPT_LINE_LENGTH);
}

let cachedStackParser: StackUtils | undefined;
function getStackParser(): StackUtils {
  return (cachedStackParser ??= new StackUtils({
    cwd: process.cwd(),
    internals: StackUtils.nodeInternals(),
  }));
}

type Props = {
  readonly error: Error;
};

export default function ErrorPresentation({ error }: Props) {
  const stack = error.stack ? error.stack.split("\n").slice(1) : undefined;
  const origin = stack ? getStackParser().parseLine(stack[0]!) : undefined;
  const filePath = normalizeFilePath(origin?.file);
  let excerpt: CodeExcerpt[] | undefined;
  let lineWidth = 0;

  if (filePath && origin?.line && !isInternalFrame(filePath)) {
    try {
      const sourceCode = readFileSync(filePath, "utf8");
      excerpt = codeExcerpt(sourceCode, origin.line);

      if (excerpt && hasLongExcerptLine(excerpt)) {
        excerpt = undefined;
      }

      if (excerpt) {
        for (const { line } of excerpt) {
          lineWidth = Math.max(lineWidth, String(line).length);
        }
      }
    } catch {}
  }

  return (
    <FlexContainer flexDirection="column" padding={1}>
      <FlexContainer>
        <StyledText backgroundColor="ansi:red" color="ansi:white">
          {" "}
          ERROR{" "}
        </StyledText>

        <StyledText> {error.message}</StyledText>
      </FlexContainer>

      {origin && filePath && (
        <FlexContainer marginTop={1}>
          <StyledText dim>
            {filePath}:{origin.line}:{origin.column}
          </StyledText>
        </FlexContainer>
      )}

      {origin && excerpt && (
        <FlexContainer marginTop={1} flexDirection="column">
          {excerpt.map(({ line, value }) => (
            <FlexContainer key={line}>
              <FlexContainer width={lineWidth + 1}>
                <StyledText
                  dim={line !== origin.line}
                  backgroundColor={line === origin.line ? "ansi:red" : undefined}
                  color={line === origin.line ? "ansi:white" : undefined}
                >
                  {String(line).padStart(lineWidth, " ")}:
                </StyledText>
              </FlexContainer>

              <StyledText
                key={line}
                backgroundColor={line === origin.line ? "ansi:red" : undefined}
                color={line === origin.line ? "ansi:white" : undefined}
              >
                {" " + value}
              </StyledText>
            </FlexContainer>
          ))}
        </FlexContainer>
      )}

      {error.stack && (
        <FlexContainer marginTop={1} flexDirection="column">
          {error.stack
            .split("\n")
            .slice(1)
            .map((line) => {
              const parsedLine = getStackParser().parseLine(line);

              if (!parsedLine) {
                return (
                  <FlexContainer key={line}>
                    <StyledText dim>- </StyledText>
                    <StyledText bold>{line}</StyledText>
                  </FlexContainer>
                );
              }

              return (
                <FlexContainer key={line}>
                  <StyledText dim>- </StyledText>
                  <StyledText bold>{parsedLine.function}</StyledText>
                  <StyledText dim>
                    {" "}
                    ({normalizeFilePath(parsedLine.file) ?? ""}:{parsedLine.line}:
                    {parsedLine.column})
                  </StyledText>
                </FlexContainer>
              );
            })}
        </FlexContainer>
      )}
    </FlexContainer>
  );
}
