import { collectText, sendSizedRequest } from "@/engine/transport/http1-socket.ts";
import { userAgent } from "./fingerprint.ts";

/** A CodeAssist call's answer: the status, its headers, and the body as text. */
export interface CodeAssistReply {
  status: number;
  ok: boolean;
  headers: Map<string, string>;
  text: string;
}

export interface CodeAssistCall {
  url: string;
  accessToken: string;
  /** A JSON body for POST; absent, the call is a GET. */
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

// Every non-streaming CodeAssist call goes out the way the installed client
// sends it: HTTP/1.1, these headers in this order, the body sized up front.
// Content-Length sits right after User-Agent; Host leads, written by the transport.
const CONTENT_LENGTH_AT = 1;

export async function callCodeAssist(call: CodeAssistCall): Promise<CodeAssistReply> {
  const headerLines = [
    `User-Agent: ${userAgent()}`,
    `Authorization: Bearer ${call.accessToken}`,
    "Content-Type: application/json",
    "Accept-Encoding: gzip",
  ];
  const payload = Buffer.from(call.body === undefined ? "" : JSON.stringify(call.body), "utf8");
  const res = await sendSizedRequest(
    {
      url: new URL(call.url),
      method: call.body === undefined ? "GET" : "POST",
      headerLines,
      payload,
      ...(call.signal ? { abortSignal: call.signal } : {}),
    },
    CONTENT_LENGTH_AT,
  );
  const text = await collectText(res.body);
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: res.headers,
    text,
  };
}

/** Parses a reply's JSON body; a body that is not JSON reads as null. */
export function replyJson(reply: CodeAssistReply): unknown {
  try {
    return JSON.parse(reply.text);
  } catch {
    return null;
  }
}
