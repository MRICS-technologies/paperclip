import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1024 * 1024; // Telegram updates are a few KB
const sha = (s) => createHash('sha256').update(s).digest();
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b)); // hashing equalises lengths

export function loadConfig(env = process.env) {
  const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'GROQ_API_KEY', 'PAPERCLIP_WEBHOOK_URL'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}`);
  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    groqKey: env.GROQ_API_KEY,
    paperclipUrl: env.PAPERCLIP_WEBHOOK_URL,
    language: env.STT_LANGUAGE || undefined,
    port: Number(env.PORT) || 8080,
    maxAudioBytes: Number(env.MAX_AUDIO_BYTES) || 20 * 1024 * 1024,
  };
}

// Error messages must never include URLs: they contain the bot token.
async function transcribe(fileId, cfg, fetch, signal) {
  const meta = await (await fetch(`https://api.telegram.org/bot${cfg.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal })).json();
  const path = meta.result?.file_path;
  if (!meta.ok || !path) throw new Error(`getFile failed: ${meta.description ?? 'no file_path'}`);
  if (meta.result.file_size > cfg.maxAudioBytes) throw new Error(`audio too large: ${meta.result.file_size} bytes`);

  const dl = await fetch(`https://api.telegram.org/file/bot${cfg.botToken}/${path}`, { signal });
  if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
  const bytes = await dl.arrayBuffer();
  if (bytes.byteLength > cfg.maxAudioBytes) throw new Error(`audio too large: ${bytes.byteLength} bytes`);

  const form = new FormData();
  // Whisper picks the decoder from the extension; Telegram voice notes are .oga (Ogg/Opus).
  form.append('file', new Blob([bytes]), path.split('/').pop().replace(/\.oga$/, '.ogg'));
  form.append('model', 'whisper-large-v3-turbo');
  if (cfg.language) form.append('language', cfg.language);
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${cfg.groqKey}` }, body: form, signal,
  });
  if (!r.ok) throw new Error(`groq HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = (await r.json()).text?.trim();
  if (!text) throw new Error('empty transcript');
  return text;
}

// Returns the same object when nothing changed (caller forwards the raw body then).
export async function processUpdate(update, cfg, fetch) {
  const msg = update?.message;
  const media = msg?.voice ?? msg?.audio;
  if (!media?.file_id) return update;
  try {
    const transcript = await transcribe(media.file_id, cfg, fetch, AbortSignal.timeout(20_000));
    const { voice, audio, caption, caption_entities, ...rest } = msg;
    return { ...update, message: { ...rest, text: caption ? `${caption}\n\n${transcript}` : transcript } };
  } catch (err) {
    console.error(`update ${update.update_id}: transcription failed, forwarding original: ${err.message}`);
    return update;
  }
}

export function createHandler(cfg, fetch = globalThis.fetch) {
  return async (req, res) => {
    const send = (status) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status === 200 }));
    };
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (req.method === 'GET' && path === '/health') return send(200);
      if (req.method !== 'POST' || (path !== '/' && path !== '/webhook')) return send(404);
      if (!safeEqual(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''), cfg.secret)) return send(401);

      const chunks = [];
      let size = 0;
      for await (const c of req) {
        if ((size += c.length) > MAX_BODY) return send(413);
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let update;
      try { update = JSON.parse(raw); } catch { return send(400); }

      const out = await processUpdate(update, cfg, fetch);
      const r = await fetch(cfg.paperclipUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': cfg.secret },
        body: out === update ? raw : JSON.stringify(out),
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) throw new Error(`paperclip HTTP ${r.status}`);
      send(200);
    } catch (err) {
      // Non-2xx makes Telegram redeliver the update, so a Paperclip outage doesn't lose messages.
      console.error(`forward failed: ${err.message}`);
      send(502);
    }
  };
}
