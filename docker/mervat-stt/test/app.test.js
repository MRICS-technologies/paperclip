import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../src/app.js';

const cfg = { botToken: 'TOK', secret: 's3cret', groqKey: 'G', paperclipUrl: 'http://paperclip/hook', maxAudioBytes: 1e6 };

// Fake upstreams: Telegram getFile/download, Groq, Paperclip. Records what Paperclip received.
function fakeFetch({ groqStatus = 200, transcript = 'hello from voice' } = {}) {
  const forwarded = [];
  const fetch = async (url, init = {}) => {
    if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: 3 } });
    if (url.includes('/file/botTOK/')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.includes('groq.com')) {
      assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
      assert.equal(init.body.get('file').name, 'file_1.ogg');
      return groqStatus === 200 ? Response.json({ text: transcript }) : new Response('boom', { status: groqStatus });
    }
    if (url === cfg.paperclipUrl) {
      forwarded.push({ headers: init.headers, body: init.body });
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, forwarded };
}

async function post(fetchImpl, body, headers = { 'x-telegram-bot-api-secret-token': cfg.secret }) {
  const server = createServer(createHandler(cfg, fetchImpl)).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, { method: 'POST', headers, body });
    return res.status;
  } finally {
    server.close();
  }
}

const base = { message_id: 7, from: { id: 1 }, chat: { id: 2 }, date: 1700000000, message_thread_id: 9 };

test('non-voice update is forwarded verbatim with secret header', async () => {
  const f = fakeFetch();
  const raw = JSON.stringify({ update_id: 1, message: { ...base, text: 'hi' } });
  assert.equal(await post(f.fetch, raw), 200);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].body, raw);
  assert.equal(f.forwarded[0].headers['x-telegram-bot-api-secret-token'], 's3cret');
});

test('voice update is rewritten to text with caption', async () => {
  const f = fakeFetch();
  const raw = JSON.stringify({ update_id: 2, message: { ...base, voice: { file_id: 'F' }, caption: 'cap', caption_entities: [] } });
  assert.equal(await post(f.fetch, raw), 200);
  const msg = JSON.parse(f.forwarded[0].body).message;
  assert.deepEqual(msg, { ...base, text: 'cap\n\nhello from voice' });
});

test('audio update without caption becomes transcript text', async () => {
  const f = fakeFetch();
  await post(f.fetch, JSON.stringify({ update_id: 3, message: { ...base, audio: { file_id: 'F' } } }));
  assert.deepEqual(JSON.parse(f.forwarded[0].body).message, { ...base, text: 'hello from voice' });
});

test('transcription error forwards original update (fail-open)', async () => {
  const f = fakeFetch({ groqStatus: 500 });
  const raw = JSON.stringify({ update_id: 4, message: { ...base, voice: { file_id: 'F' } } });
  assert.equal(await post(f.fetch, raw), 200);
  assert.equal(f.forwarded[0].body, raw);
});

test('wrong or missing secret returns 401 and forwards nothing', async () => {
  const f = fakeFetch();
  const raw = JSON.stringify({ update_id: 5, message: { ...base, text: 'hi' } });
  assert.equal(await post(f.fetch, raw, { 'x-telegram-bot-api-secret-token': 'nope' }), 401);
  assert.equal(await post(f.fetch, raw, {}), 401);
  assert.equal(f.forwarded.length, 0);
});
