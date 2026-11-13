'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * NEXUS-20 Multi-Provider AI Brain Adapters (16 Providers + Zero-AI Offline Mode).
 *
 * Supports:
 * - `none`        : Pure Zero-AI Deterministic Mode (0 API calls, £0)
 * - `gemini`      : Google Gemini (`generativelanguage.googleapis.com`)
 * - `openai`      : OpenAI ChatGPT (`api.openai.com`)
 * - `anthropic`   : Anthropic Claude (`api.anthropic.com`)
 * - `groq`        : Groq Ultra-Fast LPU (`api.groq.com/openai/v1`)
 * - `openrouter`  : OpenRouter 300+ Free & Paid Models (`openrouter.ai/api/v1`)
 * - `deepseek`    : DeepSeek V3 / R1 (`api.deepseek.com`)
 * - `xai`         : xAI Grok (`api.x.ai/v1`)
 * - `mistral`     : Mistral AI (`api.mistral.ai/v1`)
 * - `together`    : Together AI (`api.together.xyz/v1`)
 * - `cerebras`    : Cerebras Wafer-Scale (`api.cerebras.ai/v1`)
 * - `fireworks`   : Fireworks AI (`api.fireworks.ai/inference/v1`)
 * - `perplexity`  : Perplexity Sonar (`api.perplexity.ai`)
 * - `cohere`      : Cohere Command (`api.cohere.com/v2`)
 * - `lmstudio`    : LM Studio / vLLM / Local OpenAI-Compatible Server
 * - `ollama`      : Self-Hosted Ollama LAN/VPN Server
 */

const AI_PROVIDER_CATALOG = Object.freeze({
  none: {
    id: 'none',
    label: 'Zero-AI Offline Mode (1,370+ Built-in Commands, £0)',
    protocol: 'none',
    requiresApiKey: false,
    defaultBaseUrl: null,
    defaultModel: 'deterministic-v2',
    models: ['deterministic-v2'],
    envKeyName: null
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (Gemini 2.5 Flash / Pro)',
    protocol: 'gemini',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    envKeyName: 'GEMINI_API_KEY'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI / ChatGPT (GPT-4o / GPT-4.1 / o4-mini)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    envKeyName: 'OPENAI_API_KEY'
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude (Claude Sonnet 4 / 3.7 / Haiku)',
    protocol: 'anthropic',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    envKeyName: 'ANTHROPIC_API_KEY'
  },
  groq: {
    id: 'groq',
    label: 'Groq LPU (Llama 3.3 70B / Qwen — Free Tier Available)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-qwq-32b'],
    envKeyName: 'GROQ_API_KEY'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (300+ Models incl. Free Gemini/DeepSeek/Llama)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-chat-v3-0324:free',
      'google/gemini-2.0-flash-exp:free',
      'anthropic/claude-3.7-sonnet',
      'openai/gpt-4o-mini'
    ],
    envKeyName: 'OPENROUTER_API_KEY'
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (DeepSeek-V3 Chat / R1 Reasoner)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    envKeyName: 'DEEPSEEK_API_KEY'
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok (Grok 3 / Grok 3 Mini)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
    models: ['grok-3-mini', 'grok-3'],
    envKeyName: 'XAI_API_KEY'
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI (Mistral Large / Small / Codestral)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest', 'codestral-latest'],
    envKeyName: 'MISTRAL_API_KEY'
  },
  together: {
    id: 'together',
    label: 'Together AI (Llama 3.3 / Qwen 2.5 Turbo)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    envKeyName: 'TOGETHER_API_KEY'
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras Wafer-Scale (2,000+ tok/s Llama 3.3)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    models: ['llama-3.3-70b', 'llama3.1-8b'],
    envKeyName: 'CEREBRAS_API_KEY'
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI (Fast Open Models)',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    envKeyName: 'FIREWORKS_API_KEY'
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity Sonar',
    protocol: 'openai',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
    models: ['sonar', 'sonar-pro'],
    envKeyName: 'PERPLEXITY_API_KEY'
  },
  cohere: {
    id: 'cohere',
    label: 'Cohere Command (Command A / R+)',
    protocol: 'cohere',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.cohere.com/v2',
    defaultModel: 'command-a-03-2025',
    models: ['command-a-03-2025', 'command-r-plus-08-2024'],
    envKeyName: 'COHERE_API_KEY'
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio / vLLM / Custom OpenAI Server',
    protocol: 'openai',
    requiresApiKey: false,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    models: ['local-model', 'qwen2.5-7b-instruct', 'llama-3.1-8b-instruct'],
    envKeyName: 'SWARM_AI_API_KEY'
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama Self-Hosted LAN/VPN Server',
    protocol: 'ollama',
    requiresApiKey: false,
    defaultBaseUrl: 'http://192.168.1.100:11434',
    defaultModel: 'qwen2.5:7b-instruct',
    models: ['qwen2.5:7b-instruct', 'llama3.1:8b', 'mistral:7b', 'gemma2:9b'],
    envKeyName: null
  }
});

const RICH_TASK_PLAN_SYSTEM_PROMPT = [
  'You are the NEXUS-20 Central Minecraft Swarm Planner.',
  'Output ONLY a raw JSON object matching TaskPlanV1 (no markdown fences, no commentary):',
  '{',
  '  "schemaVersion": 1,',
  '  "requestId": "<same UUID from input>",',
  '  "intentSummary": "<short summary>",',
  '  "clarificationRequired": false,',
  '  "clarificationQuestion": null,',
  '  "objectives": [',
  '    {',
  '      "localId": "step_1",',
  '      "kind": "mine|collect|craft|build|explore|guard|transfer|repair|inspect",',
  '      "target": { "resourceId": "minecraft:raw_iron", "quantity": 16, "regionLabel": null, "description": "Mine 16 raw iron" },',
  '      "dependencies": [],',
  '      "parallelism": "partitionable|single|spatial|role_based",',
  '      "workerCountHint": 2,',
  '      "constraints": { "maxRisk": "low", "avoidHazards": ["lava"], "allowExistingStock": false, "maxTravelBlocks": 256 },',
  '      "verification": "newly_collected|crafted_output|block_state|region_visited|role_duration|deposited_stock"',
  '    }',
  '  ],',
  '  "riskLevel": "low",',
  '  "notes": []',
  '}',
  'Rules: max 16 objectives; craft uses parallelism="single", verification="crafted_output"; mine/collect uses verification="newly_collected"; dependencies use [{"localId":"step_1","edgeType":"finish_to_start"}].'
].join('\n');

function extractJsonText(rawText) {
  const trimmed = String(rawText || '').trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenceMatch) return fenceMatch[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function postJsonRequest(targetUrl, headers, payloadObj, signal, maxResponseBytes = 65_536) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      const err = new Error(`Invalid AI provider URL: ${targetUrl}`);
      err.code = 'AI_INVALID_ENDPOINT';
      reject(err);
      return;
    }
    const bodyBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsedUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.byteLength,
          ...headers
        },
        signal
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.byteLength;
          if (total > maxResponseBytes) {
            req.destroy();
            const err = new Error('AI response exceeded byte limit');
            err.code = 'AI_RESPONSE_TOO_LARGE';
            reject(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`AI provider HTTP ${res.statusCode}: ${raw.slice(0, 180)}`);
            err.code = 'AI_TRANSPORT_ERROR';
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            const err = new Error(`Malformed provider JSON envelope: ${e.message}`);
            err.code = 'AI_INVALID_MODEL_JSON';
            reject(err);
          }
        });
      }
    );
    req.on('error', (err) => {
      if (signal?.aborted) {
        const abortErr = new Error('AI request aborted or timed out');
        abortErr.code = 'AI_TIMEOUT';
        reject(abortErr);
        return;
      }
      const wrapped = new Error(`AI transport error: ${err.message}`);
      wrapped.code = 'AI_TRANSPORT_ERROR';
      reject(wrapped);
    });
    req.write(bodyBuf);
    req.end();
  });
}

function createCloudProviderAdapter(providerMeta, getRuntimeSettings) {
  return {
    isAvailable: () => {
      if (providerMeta.protocol === 'none') return false;
      const cfg = getRuntimeSettings(providerMeta.id);
      if (providerMeta.requiresApiKey && !cfg.apiKey) return false;
      return Boolean(cfg.baseUrl || providerMeta.defaultBaseUrl);
    },
    invoke: async ({ body, signal }) => {
      const cfg = getRuntimeSettings(providerMeta.id);
      const model = cfg.model || providerMeta.defaultModel;
      const baseUrl = String(cfg.baseUrl || providerMeta.defaultBaseUrl || '').replace(/\/+$/, '');
      const userPrompt = body?.messages?.[1]?.content || '{}';

      if (providerMeta.protocol === 'gemini') {
        const endpoint = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`;
        const gemRes = await postJsonRequest(
          endpoint,
          {},
          {
            systemInstruction: { parts: [{ text: RICH_TASK_PLAN_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 1024,
              responseMimeType: 'application/json'
            }
          },
          signal
        );
        const text = gemRes?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return { message: { content: extractJsonText(text) } };
      }

      if (providerMeta.protocol === 'anthropic') {
        const endpoint = `${baseUrl}/messages`;
        const antRes = await postJsonRequest(
          endpoint,
          {
            'x-api-key': cfg.apiKey || '',
            'anthropic-version': '2023-06-01'
          },
          {
            model,
            max_tokens: 1024,
            temperature: 0,
            system: RICH_TASK_PLAN_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }]
          },
          signal
        );
        const textBlock = Array.isArray(antRes?.content)
          ? antRes.content.find((c) => c.type === 'text')?.text || ''
          : '';
        return { message: { content: extractJsonText(textBlock) } };
      }

      if (providerMeta.protocol === 'cohere') {
        const endpoint = `${baseUrl}/chat`;
        const cohRes = await postJsonRequest(
          endpoint,
          { Authorization: `Bearer ${cfg.apiKey || ''}` },
          {
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: RICH_TASK_PLAN_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt }
            ]
          },
          signal
        );
        const text = cohRes?.message?.content?.[0]?.text || '';
        return { message: { content: extractJsonText(text) } };
      }

      // OpenAI / ChatGPT & all OpenAI-compatible providers (Groq, OpenRouter, DeepSeek, xAI Grok, Mistral, Together, Cerebras, Fireworks, Perplexity, LM Studio)
      const endpoint = `${baseUrl}/chat/completions`;
      const headers = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      if (providerMeta.id === 'openrouter') {
        headers['HTTP-Referer'] = 'https://nexus20.local';
        headers['X-Title'] = 'NEXUS-20 Minecraft Swarm';
      }
      const payload = {
        model,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: RICH_TASK_PLAN_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ]
      };
      if (providerMeta.id === 'openai' || providerMeta.id === 'groq' || providerMeta.id === 'deepseek' || providerMeta.id === 'mistral') {
        payload.response_format = { type: 'json_object' };
      }
      const oaiRes = await postJsonRequest(endpoint, headers, payload, signal);
      const text = oaiRes?.choices?.[0]?.message?.content || '';
      return { message: { content: extractJsonText(text) } };
    }
  };
}

module.exports = {
  AI_PROVIDER_CATALOG,
  RICH_TASK_PLAN_SYSTEM_PROMPT,
  extractJsonText,
  createCloudProviderAdapter
};
