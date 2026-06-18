// ─────────────────────────────────────────────────────────────────────────
// /api/openrouter — server-side OpenRouter proxy (PUBLIC endpoint).
//   ?type=chat   POST {messages, systemPrompt}  -> { content }
//   ?type=image  POST {prompt}                   -> { imageUrl }
//
// The OpenRouter API key + model selections live in the `settings` table and are
// injected here. The browser sends only prompts/messages and never sees the key.
// ─────────────────────────────────────────────────────────────────────────
import { serviceClient, applyCors, readJsonBody } from './_lib.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function loadSettings() {
  const svc = serviceClient();
  const { data, error } = await svc
    .from('settings')
    .select('openrouter_api_key, chat_model, image_model, image_size, image_aspect_ratio')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Could not load settings: ' + error.message);
  if (!data) throw new Error('Settings row missing — run the migration / seed settings.');
  if (!data.openrouter_api_key) throw new Error('No OpenRouter API key configured in Settings.');
  return data;
}

// Ported verbatim from conversation.html extractImageUrl().
function extractImageUrl(data) {
  try {
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return null;
    if (Array.isArray(msg.images) && msg.images.length) {
      const first = msg.images[0];
      if (typeof first === 'string') return first;
      if (first.image_url && first.image_url.url) return first.image_url.url;
      if (first.url) return first.url;
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url && part.image_url.url) return part.image_url.url;
        if (part.type === 'output_image' && part.url) return part.url;
      }
    }
    if (msg.content && typeof msg.content === 'string' && msg.content.startsWith('data:image')) {
      return msg.content;
    }
  } catch { /* fallthrough */ }
  return null;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const type = (req.query.type || '').toString();

  try {
    const settings = await loadSettings();
    const body = await readJsonBody(req);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.openrouter_api_key,
    };

    if (type === 'chat') {
      const { messages, systemPrompt } = body;
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages[] required' });
      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.chat_model,
          messages: [{ role: 'system', content: systemPrompt || '' }, ...messages],
        }),
      });
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Non-JSON response from OpenRouter (HTTP ' + upstream.status + ')' }); }
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ('HTTP ' + upstream.status) });
      const content = data.choices?.[0]?.message?.content;
      if (!content) return res.status(502).json({ error: 'No reply content returned.' });
      return res.status(200).json({ content: typeof content === 'string' ? content : JSON.stringify(content) });
    }

    if (type === 'image') {
      const { prompt } = body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.image_model,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text'],
          image_config: {
            aspect_ratio: settings.image_aspect_ratio,
            image_size: settings.image_size,
          },
        }),
      });
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Non-JSON response from OpenRouter (HTTP ' + upstream.status + ')' }); }
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ('HTTP ' + upstream.status) });
      const imageUrl = extractImageUrl(data);
      if (!imageUrl) return res.status(502).json({ error: 'Model responded but no image was found. Try rephrasing the brief.' });
      return res.status(200).json({ imageUrl });
    }

    return res.status(400).json({ error: 'Unknown type (expected chat|image)' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
