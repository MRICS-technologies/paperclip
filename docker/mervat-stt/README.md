# Mervat STT Proxy

Telegram voice-note transcription proxy for Paperclip's "Tante Mervat" bot (`@mrics_mervat_bot`).

Mervat runs on a text+vision model (Claude Sonnet 5) that cannot hear audio. This small, stateless service sits between Telegram and Paperclip: it transcribes incoming voice/audio messages via Groq Whisper and rewrites them into plain text so the agent can read them.

## Flow

```
Telegram  --webhook-->  mervat-stt  --forward-->  Paperclip webhook
```

- Validates the Telegram webhook secret (`x-telegram-bot-api-secret-token`).
- On a voice/audio message: `getFile` -> download audio -> Groq `whisper-large-v3-turbo` -> replace the voice with a `text` message.
- Non-voice messages pass through verbatim.
- Transcription failure fails open: the original update is still forwarded, so no message is ever lost.
- Paperclip failure returns 502 so Telegram redelivers rather than silently drops.

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Telegram Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | yes | Shared secret for inbound validation + outbound forwarding |
| `GROQ_API_KEY` | yes | Groq Whisper transcription |
| `PAPERCLIP_WEBHOOK_URL` | yes | Full Paperclip webhook URL to forward to |
| `STT_LANGUAGE` | no | ISO-639-1 language hint (e.g. `ar`, `en`) |
| `PORT` | no | Listen port (default 8080) |
| `MAX_AUDIO_BYTES` | no | Max audio size (default 20 MiB) |

No secret values are logged; Telegram file URLs (which embed the bot token) are never logged either.

## Build

```sh
docker build -t mervat-stt docker/mervat-stt
```

Zero runtime dependencies - the image is `node:22-alpine` running a plain `node:http` server.

## Test

```sh
cd docker/mervat-stt && node --test
```
