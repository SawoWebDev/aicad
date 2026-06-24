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

// Token-saving knob for the gather ('converse') phase only — it's the
// back-and-forth Q&A, so dropping the oldest turns past this cap keeps recent
// context while bounding token growth on long chats. The finalize ('analyze')
// phase is never trimmed (it needs the full transcript to build the dataset).
const MAX_CONVERSE_MESSAGES = 16;

// Normalize an OpenRouter `usage` object into the compact shape the CMS generator
// shows live (tokens in/out + USD cost). Returns null when usage is unavailable so
// the client can skip the update rather than render zeros.
function clientUsage(usage, phase) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  return {
    phase: phase || null,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens || (prompt + completion),
    cost: typeof usage.cost === 'number' ? usage.cost : 0,
  };
}

// Record one OpenRouter call's token/cost usage. Best-effort: a telemetry
// failure (e.g. the usage_events table not migrated yet) must never break the
// user-facing response, so all errors are swallowed.
async function logUsage({ model, phase, usage, sessionId, mode, latencyMs, finishReason, provider }) {
  try {
    if (!usage) return;
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    await serviceClient().from('usage_events').insert({
      model,
      phase: phase || null,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: usage.total_tokens || (prompt + completion),
      // OpenRouter returns the real USD cost when `usage:{include:true}` is sent.
      cost: typeof usage.cost === 'number' ? usage.cost : 0,
      session_id: sessionId || null,
      mode: mode != null ? Number(mode) : null,
      latency_ms: latencyMs != null ? Math.round(latencyMs) : null,
      finish_reason: finishReason || null,
      provider: provider || null,
    });
  } catch (e) {
    console.error('[usage] log failed:', e?.message || e);
  }
}

// Build the system message. For Anthropic models on the repeated gather phase we
// add a prompt-cache breakpoint so the (large, unchanging) system prompt is
// billed once per session instead of every turn. Other providers cache
// implicitly, and the one-shot finalize phase gains nothing from caching, so
// both get a plain string.
function buildSystemMessage(systemPrompt, model, phase) {
  const text = systemPrompt || '';
  if (phase === 'converse' && model.startsWith('anthropic/')) {
    return { role: 'system', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] };
  }
  return { role: 'system', content: text };
}

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
      const { messages, systemPrompt, phase, sessionId } = body;
      if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages[] required' });
      const phaseResolved = phase === 'analyze' ? 'analyze' : 'converse';
      const mode = Number(settings.pipeline_mode) || 1;
      const model = modelForPhase(settings, phaseResolved);
      // Only role/content go upstream. Messages may carry extra fields (e.g.
      // a per-message `model` slug used by the admin log viewer) that must
      // not be forwarded to OpenRouter.
      let outMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      // Gather-phase token saving: keep only the most recent turns.
      if (phaseResolved === 'converse' && outMessages.length > MAX_CONVERSE_MESSAGES) {
        outMessages = outMessages.slice(-MAX_CONVERSE_MESSAGES);
      }
      const t0 = Date.now();
      const upstream = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [buildSystemMessage(systemPrompt, model, phaseResolved), ...outMessages],
          // Ask OpenRouter to return real token counts + USD cost in the response.
          usage: { include: true },
        }),
      });
      const latencyMs = Date.now() - t0;
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Non-JSON response from OpenRouter (HTTP ' + upstream.status + ')' }); }
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ('HTTP ' + upstream.status) });
      const content = data.choices?.[0]?.message?.content;
      if (!content) return res.status(502).json({ error: 'No reply content returned.' });
      await logUsage({
        model, phase: phaseResolved, usage: data.usage, sessionId, mode,
        latencyMs, finishReason: data.choices?.[0]?.finish_reason, provider: data.provider,
      });
      // Report the model actually used so the UI can label the reply accurately
      // (no dependence on a separately-fetched config that may not have loaded).
      // `usage` is also handed back so the CMS generator can show live token/cost
      // metrics without an extra round-trip (same numbers logged above).
      return res.status(200).json({
        content: typeof content === 'string' ? content : JSON.stringify(content),
        model,
        usage: clientUsage(data.usage, phaseResolved),
      });
    }

    if (type === 'image') {
      const { prompt, sessionId } = body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      const mode = Number(settings.pipeline_mode) || 1;
      const t0 = Date.now();
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
          usage: { include: true },
        }),
      });
      const latencyMs = Date.now() - t0;
      const raw = await upstream.text();
      let data; try { data = JSON.parse(raw); } catch { return res.status(502).json({ error: 'Non-JSON response from OpenRouter (HTTP ' + upstream.status + ')' }); }
      if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || ('HTTP ' + upstream.status) });
      await logUsage({
        model: settings.image_model, phase: 'image', usage: data.usage, sessionId, mode,
        latencyMs, finishReason: data.choices?.[0]?.finish_reason, provider: data.provider,
      });
      const imageUrl = extractImageUrl(data);
      if (!imageUrl) return res.status(502).json({ error: 'Model responded but no image was found. Try rephrasing the brief.' });

      // Persist the drawing onto the conversation row HERE, server-side. The image
      // is a multi-MB base64 data URL; sending it back to the browser only to have
      // the browser re-POST it to the log endpoint hits Vercel's ~4.5 MB request
      // body cap and silently fails, so the image never reaches the logs. Writing
      // it directly (Vercel → Supabase has no such cap) makes it reliable.
      // Best-effort: a failed write must never break the user-facing image.
      if (sessionId) {
        try {
          await serviceClient()
            .from('cad_conversations')
            .update({ image_generated: true, image_url: imageUrl, updated_at: new Date().toISOString() })
            .eq('session_id', sessionId);
        } catch (e) {
          console.error('[image] persist to conversation failed:', e?.message || e);
        }
      }

      return res.status(200).json({ imageUrl, usage: clientUsage(data.usage, 'image') });
    }

    return res.status(400).json({ error: 'Unknown type (expected chat|image)' });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Server error' });
  }
}
