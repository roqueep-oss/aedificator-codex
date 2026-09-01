'use strict';
// =============================================
//  ADAPTADORES DE PROVEDOR (Gemini/OpenAI/DeepSeek/Claude)
//  Adaptação de mensagens + chamadas HTTP. As dependências do servidor
//  (config, trackTokens, fetchWithTimeout, imagens, etc.) são injetadas via
//  setProvidersContext(), quebrando o acoplamento circular.
// =============================================

let _ctx = null;
function setProvidersContext(ctx) { _ctx = ctx; }

function geminiContentsFromCanonical(messages) {
    const contents = [];
    let systemText = '';
    let systemApplied = false;
    let firstUser = true;
    for (const m of messages) {
        if (m.role === 'system') { systemText += (systemText ? '\n' : '') + m.content; continue; }
        if (m.role === 'assistant') {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            for (const tc of (m.tool_calls || [])) {
                const part = { functionCall: { name: tc.name, args: tc.args } };
                if (tc.thought_signature) part.thoughtSignature = tc.thought_signature;
                parts.push(part);
            }
            contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
        } else if (m.role === 'tool') {
            contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: String(m.content).slice(0, _ctx.toolResultMax()) } } }] });
        } else {
            const parts = [];
            if (systemText && !systemApplied) { parts.push({ text: systemText }); systemApplied = true; }
            if (firstUser && _ctx.pendingImages && _ctx.pendingImages.length) {
                for (const img of _ctx.pendingImages) {
                    if (img.dataUrl) {
                        const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)/);
                        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
                _ctx.clearPendingImages();
            }
            firstUser = false;
            parts.push({ text: m.content });
            contents.push({ role: 'user', parts });
        }
    }
    return contents;
}

async function fetchGeminiStreamRaw(url, body, onChunk, signal) {
    const response = await _ctx.fetchWithTimeout(url, {
        method: 'POST',
        // Chave via header (x-goog-api-key), não na URL — evita vazar a chave em
        // logs/proxies e em mensagens de erro de rede.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': _ctx.config.gemini.apiKey },
        body
    }, 120000, signal);
    if (!response.ok) {
        const err = await response.text();
        const hint = _ctx.getProviderErrorHint(response.status, err, 'gemini');
        const msg = hint || `Gemini HTTP ${response.status}: ${err.slice(0, 300)}`;
        _ctx.logError('gemini-api', msg, err.slice(0, 500));
        throw new Error(msg);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let usage = null;
    while (true) {
        if (signal && signal.aborted) {
            const err = new Error('Tarefa cancelada');
            err.name = 'AbortError';
            throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        buffer += chunk;
        // Captura o uso de tokens do último chunk (cumulativo) para o custo.
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            try {
                const json = JSON.parse(trimmed.slice(6));
                if (json.usageMetadata) usage = json.usageMetadata;
            } catch (e) {}
        }
    }
    if (buffer.trim().startsWith('data: ')) {
        try {
            const json = JSON.parse(buffer.trim().slice(6));
            if (json.usageMetadata) usage = json.usageMetadata;
        } catch (e) {}
    }
    return { text: fullText, usage };
}

function parseGeminiAgentResponse(rawText) {
    const toolCalls = [];
    let text = '';
    const lines = rawText.split('\n');
    for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
            const json = JSON.parse(line.slice(6));
            const candidate = json.candidates?.[0];
            if (!candidate) continue;
            const parts = candidate.content?.parts || [];
            for (const part of parts) {
                if (part.functionCall) {
                    const tc = { id: 'gem_' + Date.now() + '_' + toolCalls.length, name: part.functionCall.name, args: part.functionCall.args || {} };
                    const ts = part.thoughtSignature || part.thought_signature || part.functionCall.thoughtSignature || part.functionCall.thought_signature;
                    if (ts) tc.thought_signature = ts;
                    toolCalls.push(tc);
                }
                if (part.text) text += part.text;
            }
        } catch (e) {}
    }
    return { text, toolCalls };
}

async function callAgentGemini(messages, tools, signal) {
    const geminiKey = _ctx.config.gemini.apiKey;
    if (!geminiKey) throw new Error('Chave Gemini não configurada');
    const model = _ctx.currentTaskModel || _ctx.config.gemini.model || 'gemini-3.5-flash';
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`);
    const toolDeclarations = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const body = JSON.stringify({
        contents: geminiContentsFromCanonical(messages),
        tools: [{ functionDeclarations: toolDeclarations }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
    });
    const raw = await _ctx.retryWithBackoff(
        () => fetchGeminiStreamRaw(url, body, null, signal),
        { maxRetries: 1, baseDelay: 2000, signal }
    );
    if (raw.usage) {
        const cacheHit = raw.usage.cachedContentTokenCount || 0;
        _ctx.trackTokens('gemini', raw.usage.promptTokenCount || 0, raw.usage.candidatesTokenCount || 0, cacheHit > 0, model, cacheHit);
    }
    return parseGeminiAgentResponse(raw.text);
}

function openAIMessagesFromCanonical(messages, allowImages) {
    const out = [];
    let firstUser = true;
    for (const m of messages) {
        if (m.role === 'system') { out.push({ role: 'system', content: m.content }); continue; }
        if (m.role === 'assistant') {
            const entry = { role: 'assistant', content: m.content || null };
            if (m.tool_calls && m.tool_calls.length) {
                entry.tool_calls = m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }));
            }
            out.push(entry);
        } else if (m.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content).slice(0, _ctx.toolResultMax()) });
        } else {
            if (firstUser && allowImages) {
                firstUser = false;
                const images = _ctx.getImagePartsForOpenAI();
                if (images) {
                    out.push({ role: 'user', content: [...images, { type: 'text', text: m.content }] });
                    _ctx.clearPendingImages();
                    continue;
                }
            }
            firstUser = false;
            out.push({ role: 'user', content: m.content });
        }
    }

    // Sanitização: descarta tool messages órfãos (sem um "assistant" com
    // tool_calls antes). A API OpenAI/DeepSeek rejeita com HTTP 400 se um "tool"
    // não for resposta a uma chamada de ferramenta anterior.
    const cleaned = [];
    let expectingTool = false;
    for (const m of out) {
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
            expectingTool = true;
            cleaned.push(m);
        } else if (m.role === 'tool') {
            if (expectingTool) cleaned.push(m);
        } else {
            expectingTool = false;
            cleaned.push(m);
        }
    }
    return cleaned;
}

async function callAgentOpenAICompatible(provider, messages, tools, signal, onChunk) {
    const apiKey = provider === 'deepseek' ? _ctx.config.deepseek.apiKey : _ctx.config.openai.apiKey;
    if (!apiKey) throw new Error(`Chave ${provider} não configurada`);
    const baseUrl = provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
    const model = provider === 'deepseek' ? (_ctx.currentTaskModel || _ctx.config.deepseek.model || 'deepseek-v4-flash') : (_ctx.currentTaskModel || _ctx.config.openai.model || 'gpt-4o');

    const toolDefs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const body = { model, messages: openAIMessagesFromCanonical(messages, provider !== 'deepseek'), tools: toolDefs, tool_choice: 'auto', max_tokens: 8192 };

    // Timeout por tentativa: uma API que não responde não pode travar a tarefa
    // em "Executando" por tempo indeterminado (o watchdog é o último recurso).
    // 180s POR TENTATIVA: tool-calling (reasoning + múltiplas tool calls com
    // contexto grande) pode ultrapassar 120s, causando "This operation was
    // aborted" e fallback desnecessário para outro provider. O timer é recriado
    // a cada tentativa — se fosse compartilhado, o retry herdaria o tempo já
    // gasto e abortaria imediatamente após a primeira tentativa demorada.
    const API_TIMEOUT_MS = 180000;
    const baseSignal = signal;

    let response;
    try {
        response = await _ctx.retryWithBackoff(
            () => {
                // Cria o timeout FRESCO por tentativa (o sinal externo é imutável).
                const attemptSignal = baseSignal && typeof baseSignal.aborted === 'boolean' && typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([baseSignal, AbortSignal.timeout(API_TIMEOUT_MS)])
                    : baseSignal;
                return fetch(baseUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: _ctx.safeJsonStringify(body),
                    signal: attemptSignal
                });
            },
            {
                maxRetries: 1,
                baseDelay: 2000,
                onRetry: (attempt, max, delay) => {
                    if (onChunk) onChunk('Sistema', `⏳ Retry ${attempt}/${max}... aguardando ${delay}s\n`);
                },
                signal: baseSignal
            }
        );
    } catch (fetchErr) {
        const hint = _ctx.getProviderErrorHint(0, fetchErr.message, provider);
        const msg = hint ? hint : `❌ ${provider} indisponível: ${fetchErr.message.slice(0, 150)}`;
        if (onChunk) onChunk('Sistema', msg + '\n');
        throw new Error(msg);
    }
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const hint = _ctx.getProviderErrorHint(response.status, errorBody, provider);
        throw new Error(hint || `${provider} HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.usage) {
const model = provider === 'deepseek' ? (_ctx.currentTaskModel || _ctx.config.deepseek.model || 'deepseek-v4-flash') : (_ctx.currentTaskModel || _ctx.config.openai.model || 'gpt-4o');
        const cacheHit = provider === 'deepseek'
            ? (data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0)
            : 0;
        _ctx.trackTokens(provider, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cacheHit > 0, model, cacheHit);
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) return { text: 'Sem resposta', toolCalls: [] };
    const toolCalls = (msg.tool_calls || []).map(tc => {
        let args = {};
        try {
            args = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
            _ctx.logError('tool-args', `JSON inválido nos argumentos de ${tc.function.name}`, e.message.slice(0, 200));
        }
        return { id: tc.id, name: tc.function.name, args };
    });
    return { text: msg.content || '', toolCalls };
}

function claudeMessagesFromCanonical(messages) {
    const out = [];
    let systemText = '';
    let systemApplied = false;
    let firstUser = true;
    for (const m of messages) {
        if (m.role === 'system') { systemText += (systemText ? '\n' : '') + m.content; continue; }
        if (m.role === 'assistant') {
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const tc of (m.tool_calls || [])) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
            out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
        } else if (m.role === 'tool') {
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content).slice(0, _ctx.toolResultMax()) }] });
        } else {
            let text = m.content;
            if (systemText && !systemApplied) { text = systemText + '\n\n' + text; systemApplied = true; }
            if (firstUser) {
                firstUser = false;
                const images = _ctx.getImagePartsForClaude();
                if (images && images.length) {
                    out.push({ role: 'user', content: [...images, { type: 'text', text }] });
                    _ctx.clearPendingImages();
                    continue;
                }
            }
            out.push({ role: 'user', content: text });
        }
    }
    return out;
}

async function callAgentClaude(messages, tools, signal) {
    const apiKey = _ctx.config.claude.apiKey;
    if (!apiKey) throw new Error('Chave Claude não configurada');
    const model = _ctx.currentTaskModel || _ctx.config.claude.model || 'claude-sonnet-5';
    const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const response = await _ctx.fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: _ctx.safeJsonStringify({ model, max_tokens: 4096, messages: claudeMessagesFromCanonical(messages), tools: toolDefs })
    }, 180000, signal);
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const hint = _ctx.getProviderErrorHint(response.status, errorBody, 'claude');
        throw new Error(hint || `Claude HTTP ${response.status}: ${errorBody.slice(0, 300)}`);
    }

    const data = await response.json();
    if (data.usage) {
        const cacheHit = data.usage.cache_read_input_tokens || 0;
        _ctx.trackTokens('claude', data.usage.input_tokens || 0, data.usage.output_tokens || 0, cacheHit > 0, model, cacheHit);
    }
    const content = data.content || [];
    let text = '';
    const toolCalls = [];
    for (const block of content) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
    return { text, toolCalls };
}

async function callAgentProvider(provider, messages, tools, signal, onChunk) {
    if (provider === 'gemini') return await callAgentGemini(messages, tools, signal);
    if (provider === 'deepseek' || provider === 'openai') return await callAgentOpenAICompatible(provider, messages, tools, signal, onChunk);
    if (provider === 'claude') return await callAgentClaude(messages, tools, signal);
    throw new Error(`Modo agente não suportado para ${provider}`);
}

function getConfiguredProviders() {
    const providers = [];
    if (_ctx.config.gemini?.apiKey) providers.push('gemini');
    if (_ctx.config.deepseek?.apiKey) providers.push('deepseek');
    if (_ctx.config.openai?.apiKey) providers.push('openai');
    if (_ctx.config.claude?.apiKey) providers.push('claude');
    return providers;
}

async function callAgentProviderWithFallback(primary, messages, tools, signal, onChunk, activeProviderRef) {
    const candidates = [primary, ...getConfiguredProviders().filter(p => p !== primary)];
    let lastErr = null;
    for (const candidate of candidates) {
        try {
            const result = await callAgentProvider(candidate, messages, tools, signal, onChunk);
            if (candidate !== primary) {
                if (onChunk) onChunk('Sistema', `🔁 Provider ${candidate} assumiu (fallback automático).\n`);
                if (activeProviderRef) activeProviderRef.value = candidate;
                _ctx.currentAgentProvider = candidate;
            }
            return result;
        } catch (err) {
            lastErr = err;
            const eligible = _ctx.isFallbackEligibleError(err);
            const isLast = candidate === candidates[candidates.length - 1];
            if (isLast) break;
            if (onChunk) onChunk('Sistema', `⚠️ ${candidate} falhou (${err.message.slice(0, 100)}). Tentando ${candidates[candidates.length - 1]}...\n`);
            if (!eligible) break;
        }
    }
    throw lastErr || new Error('Todos os providers falharam');
}
module.exports = {
    geminiContentsFromCanonical,
    openAIMessagesFromCanonical,
    claudeMessagesFromCanonical,
    callAgentGemini,
    callAgentOpenAICompatible,
    callAgentClaude,
    callAgentProvider,
    callAgentProviderWithFallback,
    getConfiguredProviders,
    setProvidersContext
};
