import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { registerAllProviders } from "@/engine/providers/bootstrap.ts";
import type { ToolResultContentBlock } from "@/kernel/std/types/message.ts";
import type { RequestContext } from "@/kernel/std/types/request.ts";
import { Read } from "../read.ts";

registerAllProviders();

function opaquePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = (offset / 4) % 251;
    png.data[offset + 1] = 91;
    png.data[offset + 2] = 173;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("Read image results", () => {
  it("keeps original image bytes for route preparation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otherside-read-image-"));
    const filePath = join(directory, "fixture.png");
    const original = opaquePng(1800, 1500);
    writeFileSync(filePath, original);

    try {
      const context: RequestContext = {
        provider: "anthropic",
        model: "claude-sonnet-5",
        sessionId: "read-image-session",
        cwd: directory,
        effort: null,
        permissionMode: "default",
      };
      const result = await Read.run(
        { id: "read-image", name: "Read", input: { file_path: filePath } },
        context,
      );
      const content = result.content as ToolResultContentBlock[];
      const image = content.find((block) => block.type === "image");

      expect(image?.type).toBe("image");
      if (!image || image.type !== "image") throw new Error("Read image missing");
      expect(image.source.data).toBe(original.toString("base64"));
      expect(image.dimensions).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
