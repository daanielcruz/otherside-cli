import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  imageFilePathFrom,
  readPastedImageFile,
  splitPastedImagePaths,
} from "@/ui/input/paste/image-path.ts";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("imageFilePathFrom", () => {
  it("accepts an absolute image path", () => {
    expect(imageFilePathFrom("/Users/someone/Downloads/shot.png")).toBe(
      "/Users/someone/Downloads/shot.png",
    );
  });

  it("unescapes the spaces a dragged path carries", () => {
    expect(imageFilePathFrom("/Users/someone/Downloads/Resultado\\ –\\ Desk\\ Data.png ")).toBe(
      "/Users/someone/Downloads/Resultado – Desk Data.png",
    );
  });

  it("strips surrounding quotes", () => {
    expect(imageFilePathFrom("'/tmp/a b.jpeg'")).toBe("/tmp/a b.jpeg");
    expect(imageFilePathFrom('"/tmp/c.webp"')).toBe("/tmp/c.webp");
  });

  it("rejects relative paths and non-image files", () => {
    expect(imageFilePathFrom("shot.png")).toBeNull();
    expect(imageFilePathFrom("/tmp/notes.txt")).toBeNull();
    expect(imageFilePathFrom("/tmp/archive.png.zip")).toBeNull();
  });

  it("rejects prose that merely mentions an image", () => {
    expect(imageFilePathFrom("look at /tmp/shot.png please")).toBeNull();
  });
});

describe("splitPastedImagePaths", () => {
  it("separates several dragged files from the text around them", () => {
    const { imagePaths, text } = splitPastedImagePaths(
      "/tmp/one.png /tmp/two\\ b.jpg\nfix the header",
    );
    expect(imagePaths).toEqual(["/tmp/one.png", "/tmp/two b.jpg"]);
    expect(text).toBe("fix the header");
  });

  it("leaves a paste with no image path untouched", () => {
    const { imagePaths, text } = splitPastedImagePaths("just some text\nwith lines");
    expect(imagePaths).toEqual([]);
    expect(text).toBe("just some text\nwith lines");
  });
});

describe("readPastedImageFile", () => {
  it("reads the file and detects its media type from the bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "paste-image-"));
    try {
      const path = join(dir, "real.png");
      writeFileSync(path, Buffer.concat([PNG_HEADER, Buffer.from("payload")]));
      const image = readPastedImageFile(path);
      expect(image?.mediaType).toBe("image/png");
      expect(Buffer.from(image?.base64 ?? "", "base64").subarray(0, 8)).toEqual(PNG_HEADER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing or empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "paste-image-"));
    try {
      expect(readPastedImageFile(join(dir, "missing.png"))).toBeNull();
      const empty = join(dir, "empty.png");
      writeFileSync(empty, "");
      expect(readPastedImageFile(empty)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
