import blackHoleAsset from "../../../assets/black-hole.png" with { type: "file" };

let cachedBlackHoleDataUri: string | null = null;

async function blackHoleDataUri(): Promise<string> {
  if (cachedBlackHoleDataUri) return cachedBlackHoleDataUri;
  const buf = await Bun.file(blackHoleAsset).arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  cachedBlackHoleDataUri = `data:image/png;base64,${b64}`;
  return cachedBlackHoleDataUri;
}

export async function oauthSuccessHtml(providerLabel: string): Promise<string> {
  const safeLabel = providerLabel.replace(/[<>&"']/g, (c) => {
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === "&") return "&amp;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
  const blackHole = await blackHoleDataUri();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Otherside · Login successful</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  html, body {
    margin: 0;
    padding: 0;
    background: #0b0b0c;
    color: #d4d4d4;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    height: 100%;
  }
  body { display: flex; align-items: center; justify-content: center; }
  .card {
    text-align: center;
    padding: 40px 32px;
    border: 1px solid #1f1f22;
    border-radius: 14px;
    background: #111114;
    max-width: 420px;
    box-shadow: 0 0 60px rgba(167, 232, 255, 0.04);
  }
  .logo {
    width: 96px;
    height: 96px;
    margin: 0 auto 24px;
    display: block;
    object-fit: contain;
  }
  h1 { font-size: 18px; margin: 0 0 6px; color: #ffffff; font-weight: 600; letter-spacing: 0.2px; }
  p { margin: 6px 0; font-size: 13.5px; line-height: 1.5; color: #999999; }
  .accent { color: #a7e8ff; }
  .small { margin-top: 18px; font-size: 12px; color: #666666; }
</style>
</head>
<body>
  <div class="card">
    <img src="${blackHole}" alt="" class="logo" aria-hidden="true">
    <h1>Login successful</h1>
    <p>Signed in to <span class="accent">${safeLabel}</span>.</p>
    <p class="small">You can close this tab.</p>
  </div>
  <script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 1200);</script>
</body>
</html>`;
}

export async function oauthSuccessResponse(providerLabel: string): Promise<Response> {
  return new Response(await oauthSuccessHtml(providerLabel), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
