import * as db from './db.js';

let _config = null;

function buildApiUrl(baseUrl, endpointPath) {
  const base = String(baseUrl || '').trim();
  if (!base) return `/api${endpointPath}`;
  if (/^https?:\/\//i.test(base)) return `${base.replace(/\/+$/, '')}${endpointPath}`;
  if (base.startsWith('/')) return `${base.replace(/\/+$/, '')}${endpointPath}`;
  return `/${base.replace(/^\/+/, '').replace(/\/+$/, '')}${endpointPath}`;
}

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
  const primaryUrl = buildApiUrl(config.baseUrl, '/v1/models');
  const fallbackUrl = '/api/v1/models';
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    Object.assign(headers, config.customHeaders || {});
    let res;
    try {
      res = await fetch(primaryUrl, { headers });
    } catch (e) {
      const wrapped = wrapNetworkError(e, primaryUrl);
      // 本地开发场景：若直连跨域失败，自动回退同源中转
      if (fallbackUrl !== primaryUrl && /CORS|浏览器拦截/.test(String(wrapped?.message || ''))) {
        res = await fetch(fallbackUrl, { headers });
      } else {
        throw wrapped;
      }
    }
    const data = await res.json();
    return (data.data || []).map(m => m.id).sort();
  } catch (e) {
    console.error('Fetch models error:', e);
    return [];
  }
}

function wrapNetworkError(err, url = '') {
  const raw = String(err?.message || err || '');
  const isCorsLike = err?.name === 'TypeError' && /Failed to fetch|NetworkError|Load failed/i.test(raw);
  if (isCorsLike) {
    const host = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return url || '目标地址';
      }
    })();
    return new Error(
      `网络请求被浏览器拦截（常见为 CORS）。当前页面无法直接访问 ${host}。请改用同源代理地址，或在接口侧增加 Access-Control-Allow-Origin。`
    );
  }
  return err instanceof Error ? err : new Error(raw || '网络请求失败');
}

export async function chat(messages, options = {}) {
  const config = await getConfig();
  const url = buildApiUrl(config.baseUrl, '/v1/chat/completions');
  const fallbackUrl = '/api/v1/chat/completions';
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

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (e) {
    const wrapped = wrapNetworkError(e, url);
    if (fallbackUrl !== url && /CORS|浏览器拦截/.test(String(wrapped?.message || ''))) {
      res = await fetch(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } else {
      throw wrapped;
    }
  }

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
