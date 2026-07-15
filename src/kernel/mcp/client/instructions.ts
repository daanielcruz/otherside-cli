export interface McpInstructionBlock {
  server: string;
  text: string;
}

let blocks: McpInstructionBlock[] = [];

export function setMcpInstructionBlocks(next: McpInstructionBlock[]): void {
  blocks = next
    .filter((block) => block.text.trim().length > 0)
    .map((block) => ({ server: block.server, text: block.text.trim() }));
}

export function getMcpInstructionBlocks(): McpInstructionBlock[] {
  return blocks;
}
