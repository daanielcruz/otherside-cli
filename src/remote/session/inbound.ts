import { join } from "node:path";
import { mkdirSecure, writeFileSecure } from "@/kernel/std/fs/secure-fs.ts";
import type { ImageMediaType } from "@/kernel/std/types/image.ts";
import type { ContentBlock } from "@/kernel/std/types/message.ts";
import { remoteHome } from "@/remote/_infra/paths.ts";

export interface RemoteAttachment {
  name: string;
  mimeType: string;
  base64: string;
  size?: number;
}

export interface IncomingMessage {
  text: string;
  blocks: ContentBlock[];
  attachments: RemoteAttachment[];
}

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SAFE_NAME_RE = /[^a-zA-Z0-9._-]+/g;

export interface BuildIncomingMessageDeps {
  mkdirSecure?: typeof mkdirSecure;
  writeFileSecure?: typeof writeFileSecure;
  remoteHome?: typeof remoteHome;
}

export function createBuildIncomingMessage(deps: BuildIncomingMessageDeps = {}) {
  const mkdir = deps.mkdirSecure ?? mkdirSecure;
  const writeFile = deps.writeFileSecure ?? writeFileSecure;
  const getRemoteHome = deps.remoteHome ?? remoteHome;

  function persistAttachment(
    sessionId: string,
    attachment: RemoteAttachment,
    index: number,
  ): PersistedAttachment[] {
    const dir = join(getRemoteHome(), "uploads", sessionId);
    const name = sanitizeFileName(attachment.name, index);
    const path = join(dir, name);

    try {
      mkdir(dir, 0o700);
      writeFile(path, Buffer.from(attachment.base64, "base64"), 0o600);
    } catch {
      return [];
    }

    if (isImageMediaType(attachment.mimeType)) {
      return [
        {
          path,
          isImage: true,
          block: {
            type: "image",
            source: {
              type: "base64",
              media_type: attachment.mimeType,
              data: attachment.base64,
            },
          },
        },
      ];
    }

    return [{ path, isImage: false, block: { type: "text", text: `@"${path}"` } }];
  }

  return function buildIncomingMessage(
    sessionId: string,
    payload: unknown,
  ): IncomingMessage | null {
    const message = parseIncomingPayload(payload);
    if (!message) return null;
    const persistedAttachments = message.attachments.flatMap((attachment, index) =>
      persistAttachment(sessionId, attachment, index + 1),
    );
    const text = [message.text, ...attachmentTextRefs(persistedAttachments)]
      .filter(Boolean)
      .join("\n");

    return {
      text,
      blocks: [
        ...(message.text ? [{ type: "text", text: message.text } satisfies ContentBlock] : []),
        ...persistedAttachments.map((attachment) => attachment.block),
      ],
      attachments: message.attachments,
    };
  };
}

export const buildIncomingMessage = createBuildIncomingMessage();

function parseIncomingPayload(
  payload: unknown,
): { text: string; attachments: RemoteAttachment[] } | null {
  const record = objectRecord(payload);
  if (!record) return null;
  const text = typeof record.text === "string" ? record.text : "";
  const attachments = [
    ...(Array.isArray(record.attachments) ? record.attachments.flatMap(parseAttachment) : []),
    ...(Array.isArray(record.inlineImages)
      ? record.inlineImages.flatMap((block, index) => parseInlineImage(block, index + 1))
      : []),
    ...(Array.isArray(record.content)
      ? record.content.flatMap((block, index) => parseInlineImage(block, index + 1))
      : []),
  ];
  if (!text && attachments.length === 0) return null;
  return { text, attachments };
}

function parseAttachment(value: unknown): RemoteAttachment[] {
  const record = objectRecord(value);
  if (!record) return [];
  if (
    typeof record.name !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.base64 !== "string"
  ) {
    return [];
  }
  return [
    {
      name: record.name,
      mimeType: record.mimeType,
      base64: record.base64,
      ...(typeof record.size === "number" ? { size: record.size } : {}),
    },
  ];
}

interface PersistedAttachment {
  path: string;
  block: ContentBlock;
  isImage: boolean;
}

function parseInlineImage(value: unknown, index: number): RemoteAttachment[] {
  const record = objectRecord(value);
  if (!record || record.type !== "image") return [];
  const source = objectRecord(record.source);
  if (!source) return [];
  if (
    source.type !== "base64" ||
    typeof source.media_type !== "string" ||
    typeof source.data !== "string" ||
    !isImageMediaType(source.media_type)
  ) {
    return [];
  }
  return [
    {
      name: `inline-image-${index}.${imageExtension(source.media_type)}`,
      mimeType: source.media_type,
      base64: source.data,
    },
  ];
}

function attachmentTextRefs(attachments: PersistedAttachment[]): string[] {
  let imageIndex = 0;
  return attachments.map((attachment) => {
    if (!attachment.isImage) return `@"${attachment.path}"`;
    imageIndex += 1;
    return `[Image #${imageIndex}]`;
  });
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  return mediaType.split("/")[1] ?? "png";
}

function sanitizeFileName(name: string, index: number): string {
  const cleaned = name.replace(SAFE_NAME_RE, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || `attachment-${index}`;
}

function isImageMediaType(value: string): value is ImageMediaType {
  return IMAGE_MEDIA_TYPES.has(value);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return Object.fromEntries(Object.entries(value));
}
