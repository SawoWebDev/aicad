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
    .select('openrouter_api_key, chat_model, convo_model, image_model, image_size, image_aspect_ratio, pipeline_mode')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Could not load settings: ' + error.message);
  if (!data) throw new Error('Settings row missing — run the migration / seed settings.');
  if (!data.openrouter_api_key) throw new Error('No OpenRouter API key configured in Settings.');
  return data;
}

// Public (non-secret) model config so the generator UI can show which model is
// active for the current phase. Never returns the API key.
async function loadPublicConfig() {
  const svc = serviceClient();
  const { data, error } = await svc
    .from('settings')
    .select('chat_model, convo_model, image_model, pipeline_mode')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Could not load settings: ' + error.message);
  return data || {};
}

// Which model serves a given chat phase, honoring the pipeline mode.
//   Mode 1: chat_model handles every phase.
//   Mode 2: convo_model handles 'converse'; chat_model finalizes ('analyze').
function modelForPhase(settings, phase) {
  const mode = Number(settings.pipeline_mode) || 1;
  const convo = (settings.convo_model || '').trim();
  const chat = (settings.chat_model || '').trim();
  // Mode 2: the cheap convo_model handles the gathering chat ('converse'); the
  // capable chat_model finalizes the dataset/image prompt ('analyze').
  if (mode === 2 && phase === 'converse' && convo) {
    return convo;
  }
  return chat;
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

  const type = (req.query.type || '').toString();
  // 'config' is a read-only GET; chat/image are POST.
  if (type !== 'config' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── config (GET): non-secret model info for the UI's "active model" pill ──
    if (type === 'config') {
      const cfg = await loadPublicConfig();
      return res.status(200).json({
        pipeline_mode: Number(cfg.pipeline_mode) || 1,
        chat_model: cfg.chat_model || null,
        convo_model: cfg.convo_model || null,
        image_model: cfg.image_model || null,
      });
    }

    const settings = await loadSettings();
    const body = await readJsonBody(req);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + settings.openrouter_api_key,
    };

    if (type === 'chat') {
      const { messages, systemPrompt, phase } = body;
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages[] required' });
      const model = modelForPhase(settings, phase === 'analyze' ? 'analyze' : 'converse');
      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          // Only role/content go upstream. Messages may carry extra fields (e.g.
          // a per-message `model` slug used by the admin log viewer) that must
          // not be forwarded to OpenRouter.
          messages: [
            { role: 'system', content: systemPrompt || '' },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Non-JSON response from OpenRouter (HTTP ' + upstream.status + ')' }); }
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ('HTTP ' + upstream.status) });
      const content = data.choices?.[0]?.message?.content;
      if (!content) return res.status(502).json({ error: 'No reply content returned.' });
      // Report the model actually used so the UI can label the reply accurately
      // (no dependence on a separately-fetched config that may not have loaded).
      return res.status(200).json({ content: typeof content === 'string' ? content : JSON.stringify(content), model });
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
