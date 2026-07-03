// OpenAI-compatible chat client with SSE streaming.
// Works unchanged with Groq, Gemini (OpenAI endpoint), OpenAI, OpenRouter, and any
// compatible server - only baseUrl/model/key differ. This single interface is also how
// a future local engine would plug in.

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + suffix;
}

async function streamChat({ baseUrl, apiKey, model, messages, temperature, tools, signal, onToken }) {
  const body = {
    model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    stream: true
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

  const res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && j.error.message) || '';
    } catch (_e) { /* body wasn't JSON */ }
    if (res.status === 401) detail = detail || 'Invalid API key.';
    if (res.status === 429) detail = detail || 'Rate limited - slow down or check your plan.';
    throw new Error('API ' + res.status + (detail ? ': ' + detail : ''));
  }

  // Parse the Server-Sent Events stream chunk by chunk.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = []; // [{ id, name, arguments }] - assembled from streamed fragments

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep the trailing partial line

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { content: content, toolCalls: toolCalls };
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; if (onToken) onToken(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function && tc.function.name) toolCalls[i].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      } catch (_e) {
        // keep-alive ping or split frame - ignore and continue
      }
    }
  }
  return { content: content, toolCalls: toolCalls };
}

async function listModels({ baseUrl, apiKey }) {
  const res = await fetch(joinUrl(baseUrl, '/models'), {
    headers: { Authorization: 'Bearer ' + apiKey }
  });
  if (!res.ok) throw new Error('API ' + res.status + ': ' + res.statusText);
  const json = await res.json();
  const data = (json && json.data) || [];
  return data.map((m) => m.id).filter(Boolean).sort();
}

module.exports = { streamChat, listModels };
