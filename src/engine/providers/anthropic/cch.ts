export const CCH_PLACEHOLDER = "00000";

const CCH_PREFIX = "cch=";
const XXH64_SEED = 0x4d659218e32a3268n;
const LOW20_MASK = 0xfffffn;
const MODEL_KEY = '"model":"';
const MAX_TOKENS_KEY = '"max_tokens":';

const QUOTE = 0x22;
const COMMA = 0x2c;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

function computeCchToken(buf: Buffer): string {
  const exclusions: Array<[number, number]> = [];

  const modelStart = buf.indexOf(MODEL_KEY);
  if (modelStart !== -1) {
    const start = modelStart + MODEL_KEY.length;
    const end = buf.indexOf(QUOTE, start);
    if (end !== -1) exclusions.push([start, end]);
  }

  const maxTokensStart = buf.indexOf(MAX_TOKENS_KEY);
  if (maxTokensStart !== -1) {
    let start = maxTokensStart;
    let end = maxTokensStart + MAX_TOKENS_KEY.length;
    while (end < buf.length) {
      const c = buf[end];
      if (c === undefined || c < DIGIT_ZERO || c > DIGIT_NINE) break;
      end++;
    }
    if (end < buf.length && buf[end] === COMMA) end++;
    else if (start > 0 && buf[start - 1] === COMMA) start--;
    exclusions.push([start, end]);
  }

  exclusions.sort((a, b) => a[0] - b[0]);

  const parts: Buffer[] = [];
  let last = 0;
  for (const [start, end] of exclusions) {
    parts.push(buf.subarray(last, start));
    last = end;
  }
  parts.push(buf.subarray(last));

  const hash = BigInt(Bun.hash.xxHash64(Buffer.concat(parts), XXH64_SEED));
  return (hash & LOW20_MASK).toString(16).padStart(5, "0");
}

export function applyCchAttestation(serializedBody: string): string {
  const target = CCH_PREFIX + CCH_PLACEHOLDER;
  const placeholderStart = serializedBody.indexOf(target);
  if (placeholderStart === -1) return serializedBody;
  const token = computeCchToken(Buffer.from(serializedBody, "utf8"));
  const valueStart = placeholderStart + CCH_PREFIX.length;
  return (
    serializedBody.slice(0, valueStart) +
    token +
    serializedBody.slice(valueStart + CCH_PLACEHOLDER.length)
  );
}
