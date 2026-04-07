import * as db from './db.js';

let _config = null;

export async function getConfig() {
  if (_config) return _config;
  const saved = await db.get('settings', 'apiConfig');
  _config = saved?.value || {
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 2048,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    customHeaders: {},
    endpointType: 'openai',
  };
  return _config;
}

export async function saveConfig(config) {
  _config = config;
  await db.put('settings', { key: 'apiConfig', value: config });
}

/** 微博/论坛等大段 JSON 生成：沿用用户在设置里配置的 maxTokens，避免硬编码把输出卡在 ~1.4k */
export async function resolveGenerationMaxTokens(minFloor = 4096, cap = 32768) {
  const config = await getConfig();
  const n = Number(config.maxTokens);
  const base = Number.isFinite(n) && n > 0 ? n : 8192;
  return Math.min(cap, Math.max(minFloor, base));
}

export async function fetchModels() {
  const config = await getConfig();
  if (!config.baseUrl) return [];
  try {
    const url = config.baseUrl.replace(/\/+$/, '') + '/v1/models';
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    Object.assign(headers, config.customHeaders || {});
    const res = await fetch(url, { headers });
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  } catch (e) {
    console.error('Fetch models error:', e);
    return [];
  }
}

export async function chat(messages, options = {}) {
  const config = await getConfig();
  if (!config.baseUrl) throw new Error('请先配置API地址');
  
  const url = config.baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  Object.assign(headers, config.customHeaders || {});

  const body = {
    model: options.model || config.model,
    messages,
    temperature: options.temperature ?? config.temperature,
    max_tokens: options.maxTokens ?? config.maxTokens,
    top_p: options.topP ?? config.topP,
    frequency_penalty: options.frequencyPenalty ?? config.frequencyPenalty,
    presence_penalty: options.presencePenalty ?? config.presencePenalty,
    stream: options.stream ?? false,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API错误 (${res.status}): ${err}`);
  }

  if (body.stream) {
    return readStream(res, options.onChunk);
  }

  const data = await res.json();
  return extractCompletionText(data);
}

/** 兼容各家 OpenAI 套壳返回字段差异 */
function extractCompletionText(data) {
  if (!data) return '';
  const choice = data.choices?.[0];
  if (!choice) return '';
  const msg = choice.message;
  if (typeof msg === 'string') return msg;
  if (msg?.content != null) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p?.text) return p.text;
          if (p?.content) return p.content;
          return '';
        })
        .join('');
    }
  }
  if (choice.text) return choice.text;
  if (typeof data.output === 'string') return data.output;
  return '';
}

async function readStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          fullText += delta;
          if (onChunk) onChunk(delta, fullText);
        }
      } catch (e) { /* skip malformed chunks */ }
    }
  }
  return fullText;
}

export async function chatStream(messages, onChunk, options = {}) {
  return chat(messages, { ...options, stream: true, onChunk });
}
