// Precificação (pricing.json) e contabilidade de tokens (token_usage.json).
// Estado e funções puras de custo extraídas de server.js. As únicas dependências
// externas são as chamadas a providers de IA (para atualizar preços via IA) e o
// logError do servidor — injetadas via setPricingDeps() no boot do server.js.

const fs = require('fs');
const path = require('path');

const TOKEN_PRICES = {
    deepseek: {
        '__default': { input: 0.14, output: 0.28, cache: 0.0028 },
        models: {
            'deepseek-chat': { input: 0.27, output: 1.10, cache: 0.07 },
            'deepseek-reasoner': { input: 0.55, output: 2.19, cache: 0.14 },
            'deepseek-v4-flash': { input: 0.14, output: 0.28, cache: 0.0028 },
            'deepseek-v4-pro': { input: 0.435, output: 0.87, cache: 0.0036 },
            'deepseek-coder': { input: 0.14, output: 0.28, cache: 0.0028 }
        }
    },
    gemini: {
        '__default': { input: 0.15, output: 0.60 },
        models: {
            'gemini-3.7-flash': { input: 0.15, output: 0.60 },
            'gemini-3.6-flash': { input: 0.15, output: 0.60 },
            'gemini-3.5-flash': { input: 0.15, output: 0.60 },
            'gemini-3.5-flash-lite': { input: 0.075, output: 0.30 },
            'gemini-3.1-pro': { input: 1.25, output: 5.00 },
            'gemini-3.1-flash-lite': { input: 0.075, output: 0.30 },
            'gemini-3-flash': { input: 0.15, output: 0.60 },
            'gemini-2.5-pro': { input: 1.25, output: 5.00 },
            'gemini-2.5-flash': { input: 0.15, output: 0.60 },
            'gemini-2.5-flash-lite': { input: 0.075, output: 0.30 },
            'gemini-2-flash': { input: 0.15, output: 0.60 },
            'gemini-2-flash-lite': { input: 0.075, output: 0.30 }
        }
    },
    openai: {
        '__default': { input: 2.50, output: 10.00 },
        models: {
            'gpt-4o': { input: 2.50, output: 10.00 },
            'gpt-4o-mini': { input: 0.15, output: 0.60 }
        }
    },
    claude: {
        '__default': { input: 3.00, output: 15.00 },
        models: {
            'claude-fable-5': { input: 15.00, output: 75.00 },
            'claude-opus-5': { input: 15.00, output: 75.00 },
            'claude-sonnet-5': { input: 3.00, output: 15.00 },
            'claude-haiku-4.5': { input: 1.00, output: 5.00 }
        }
    },
    opencode: {
        '__default': { input: 0.14, output: 0.28 },
        models: {
            'opencode/deepseek-v4-flash': { input: 0.14, output: 0.28 },
            'opencode/deepseek-v4-pro': { input: 0.435, output: 0.87 },
            'opencode/deepseek-chat': { input: 0.14, output: 0.28 }
        }
    }
};

function getModelPrice(provider, model) {
    const p = TOKEN_PRICES[provider];
    if (!p) return { input: 0, output: 0, cache: 0 };
    if (model && p.models && p.models[model]) return p.models[model];
    return p['__default'] || { input: 0, output: 0, cache: 0 };
}

let usdBrlRate = 5.80;
let _usdBrlLastFetch = 0;
const getUsdBrl = () => usdBrlRate;
function setUsdBrl(v) {
    if (v && v > 0) usdBrlRate = v;
}

// Dependências injetadas pelo server.js no boot (logError + chamadas de IA).
let deps = { config: null, logError: null, callGemini: null, callDeepSeek: null, callOpenAI: null, callClaude: null, extractJson: null };
function setPricingDeps(d) {
    deps = { ...deps, ...d };
}
function logErr(type, message, details) {
    if (deps.logError) deps.logError(type, message, details);
    else console.error(`[${type}] ${message} ${details || ''}`);
}

// Grava pricing.json de forma atômica (tmp + rename) para evitar corrupção
// quando timers concorrentes escrevem ao mesmo tempo.
function savePricingFile(data) {
    const pricingFile = path.join(__dirname, 'pricing.json');
    const tmpFile = pricingFile + '.tmp';
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(data), 'utf-8');
        fs.renameSync(tmpFile, pricingFile);
        return true;
    } catch (e) {
        logErr('json-parse', 'Erro ao salvar pricing.json', e.message);
        try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
        return false;
    }
}

async function fetchUsdBrlRate() {
    const now = Date.now();
    if (now - _usdBrlLastFetch < 3600000) return;
    try {
        const resp = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
        const data = await resp.json();
        const rate = parseFloat(data.USDBRL?.bid);
        if (rate && rate > 0) {
            usdBrlRate = rate;
            _usdBrlLastFetch = now;
            console.log(`💲 Cotação USD/BRL atualizada: R$ ${rate}`);
            try {
                const pricingFile = path.join(__dirname, 'pricing.json');
                const saved = fs.existsSync(pricingFile) ? JSON.parse(fs.readFileSync(pricingFile, 'utf-8')) : {};
                saved.usdBrl = rate;
                savePricingFile(saved);
            } catch (e) { logErr('json-parse', 'Erro ao salvar pricing.json', e.message); }
        }
    } catch (e) {
        console.log(`⚠️ Não foi possível obter cotação: ${e.message}`);
    }
}

let _aiPricesLastFetch = 0;

async function fetchAiPrices(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && now - _aiPricesLastFetch < 3600000) return TOKEN_PRICES;
    _aiPricesLastFetch = now;

    const pricingFile = path.join(__dirname, 'pricing.json');
    let saved = {};
    try {
        if (fs.existsSync(pricingFile)) {
            const raw = fs.readFileSync(pricingFile, 'utf-8');
            if (raw && raw.trim()) saved = JSON.parse(raw);
        }
    } catch (e) {
        logErr('json-parse', 'Erro ao ler pricing.json', e.message);
        saved = {};
    }

    const prompt = `Retorne APENAS um JSON válido (sem markdown, sem explicação) com os preços atuais por 1 milhão de tokens (USD) para estas IAs:

{
  "deepseek": {
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28, "cache": 0.0028},
    "deepseek-v4-pro": {"input": 0.435, "output": 0.87, "cache": 0.0036}
  },
  "gemini": {
    "gemini-2.5-flash": {"input": 0.15, "output": 0.60},
    "gemini-2.5-pro": {"input": 1.25, "output": 5.00}
  },
  "openai": {
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60}
  },
  "claude": {
    "claude-sonnet-4": {"input": 3.00, "output": 15.00},
    "claude-haiku-4.5": {"input": 1.00, "output": 5.00}
  }
}

Atualize os valores com os preços REAIS atuais de cada provedor. Retorne SOMENTE o JSON.`;

    const providers = [
        { name: 'Gemini', hasKey: !!(deps.config && deps.config.gemini?.apiKey), call: (p) => deps.callGemini(p, null, null) },
        { name: 'DeepSeek', hasKey: !!(deps.config && deps.config.deepseek?.apiKey), call: (p) => deps.callDeepSeek(p, null, null) },
        { name: 'OpenAI', hasKey: !!(deps.config && deps.config.openai?.apiKey), call: (p) => deps.callOpenAI(p, null, null) },
        { name: 'Claude', hasKey: !!(deps.config && deps.config.claude?.apiKey), call: (p) => deps.callClaude(p, null, null) }
    ];

    // Qualquer provider habilitado pode fornecer os preços — o primeiro que
    // responder com JSON válido é usado. Os providers não listados aqui (ex.:
    // opencode) usam os mesmos modelos base, então não precisam ser consultados.
    const enabled = providers.filter(p => p.hasKey);

    for (const provider of enabled) {
        try {
            // Preços é uma consulta simples — se o provider não responder em 30s,
            // pula para o próximo. O botão nunca fica "Buscando..." para sempre.
            const response = await Promise.race([
                provider.call(prompt),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout após 30s')), 30000))
            ]);
            // Usa o extractJson robusto (trata markdown ```json, thinking blocks
            // e texto extra ao redor) em vez do regex simples — modelos costumam
            // embrulhar o JSON e o regex {…} quebrava com comas/vírgulas extras.
            const newPrices = deps.extractJson(response);
            if (newPrices && typeof newPrices === 'object') {
                for (const [p, models] of Object.entries(newPrices)) {
                    if (TOKEN_PRICES[p] && models && typeof models === 'object') {
                        for (const [model, price] of Object.entries(models)) {
                            if (model === '__default') {
                                TOKEN_PRICES[p]['__default'] = price;
                            } else if (price && typeof price.input === 'number') {
                                if (!TOKEN_PRICES[p].models) TOKEN_PRICES[p].models = {};
                                TOKEN_PRICES[p].models[model] = price;
                            }
                        }
                    }
                }
                saved.prices = TOKEN_PRICES;
                savePricingFile(saved);
                console.log(`✅ Preços IA atualizados via ${provider.name}`);
                return TOKEN_PRICES;
            }
        } catch (e) {
            console.log(`⚠️ ${provider.name} indisponível para preços: ${e.message}`);
            logErr('ai-prices', `Falha ao buscar preços via ${provider.name}`, e.message);
        }
    }

    if (saved.prices && Object.keys(saved.prices).length > 0) {
        for (const [provider, models] of Object.entries(saved.prices)) {
            if (TOKEN_PRICES[provider]) {
                if (models.models) {
                    for (const [model, price] of Object.entries(models.models)) {
                        if (!TOKEN_PRICES[provider].models) TOKEN_PRICES[provider].models = {};
                        TOKEN_PRICES[provider].models[model] = price;
                    }
                }
                if (models['__default']) TOKEN_PRICES[provider]['__default'] = models['__default'];
            }
        }
    }
    console.log('ℹ️ Nenhum provider disponível para buscar preços, usando defaults');
    return TOKEN_PRICES;
}

const usagePath = path.join(__dirname, 'token_usage.json');
let tokenUsage = {};

function loadTokenUsage() {
    try { if (fs.existsSync(usagePath)) tokenUsage = JSON.parse(fs.readFileSync(usagePath, 'utf-8')); } catch (e) {}
    for (const p of ['deepseek', 'gemini', 'openai', 'claude', 'opencode']) {
        if (!tokenUsage[p]) tokenUsage[p] = { input: 0, output: 0, cache: 0 };
    }
}

function saveTokenUsage() {
    // Write atômico (tmp + rename) como no pricing.json: tarefas concorrentes
    // gravando ao mesmo tempo não corrompem o arquivo nem perdem atualizações.
    const tmpFile = usagePath + '.tmp';
    try {
        fs.writeFileSync(tmpFile, JSON.stringify(tokenUsage), 'utf-8');
        fs.renameSync(tmpFile, usagePath);
    } catch (e) {
        logErr('json-parse', 'Erro ao salvar token_usage.json', e.message);
        try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
    }
}

function trackTokens(provider, inputTokens, outputTokens, isCacheHit, model, cacheTokens) {
    // Separa explicitamente a parte em cache dos demais tokens de entrada.
    // Sem isso, prompt_tokens/input_tokens (que já incluem a fração em cache)
    // seriam contados inteiros como cache OU como input — nunca os dois.
    const cache = Math.min(cacheTokens != null ? cacheTokens : (isCacheHit ? inputTokens : 0), inputTokens || 0);
    const input = Math.max(0, (inputTokens || 0) - cache);
    if (!tokenUsage[provider]) tokenUsage[provider] = { input: 0, output: 0, cache: 0, models: {} };
    tokenUsage[provider].cache = (tokenUsage[provider].cache || 0) + cache;
    tokenUsage[provider].input = (tokenUsage[provider].input || 0) + input;
    tokenUsage[provider].output = (tokenUsage[provider].output || 0) + (outputTokens || 0);
    if (model) {
        if (!tokenUsage[provider].models) tokenUsage[provider].models = {};
        if (!tokenUsage[provider].models[model]) tokenUsage[provider].models[model] = { input: 0, output: 0, cache: 0 };
        tokenUsage[provider].models[model].cache = (tokenUsage[provider].models[model].cache || 0) + cache;
        tokenUsage[provider].models[model].input = (tokenUsage[provider].models[model].input || 0) + input;
        tokenUsage[provider].models[model].output = (tokenUsage[provider].models[model].output || 0) + (outputTokens || 0);
    }
    const monthKey = new Date().toISOString().slice(0, 7);
    if (!tokenUsage[provider].monthly) tokenUsage[provider].monthly = {};
    if (!tokenUsage[provider].monthly[monthKey]) tokenUsage[provider].monthly[monthKey] = { input: 0, output: 0, cache: 0 };
    tokenUsage[provider].monthly[monthKey].input += input;
    tokenUsage[provider].monthly[monthKey].output += (outputTokens || 0);
    tokenUsage[provider].monthly[monthKey].cache += cache;
    if (model) {
        const mu = tokenUsage[provider].models[model];
        if (!mu.monthly) mu.monthly = {};
        if (!mu.monthly[monthKey]) mu.monthly[monthKey] = { input: 0, output: 0, cache: 0 };
        mu.monthly[monthKey].input += input;
        mu.monthly[monthKey].output += (outputTokens || 0);
        mu.monthly[monthKey].cache += cache;
    }
    saveTokenUsage();
}

function calcCost(price, input, cache, output) {
    const inputCost = ((input || 0) / 1_000_000) * (price.input || 0);
    const cacheCost = ((cache || 0) / 1_000_000) * (price.cache || price.input || 0);
    const outputCost = ((output || 0) / 1_000_000) * (price.output || 0);
    return inputCost + cacheCost + outputCost;
}

const round4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;

// Soma o custo de um provider contabilizando cada modelo com o seu próprio
// preço, e os tokens remanescentes (dados antigos sem modelo) com o default.
function providerCost(provider) {
    const u = tokenUsage[provider];
    if (!u) return { input: 0, output: 0, cache: 0, usd: 0, perModel: {} };
    let input = 0, cache = 0, output = 0, usd = 0;
    const perModel = {};
    const modelKeys = u.models ? Object.keys(u.models) : [];
    for (const m of modelKeys) {
        const mu = u.models[m];
        const i = mu.input || 0, c = mu.cache || 0, o = mu.output || 0;
        input += i; cache += c; output += o;
        const cost = calcCost(getModelPrice(provider, m), i, c, o);
        usd += cost;
        perModel[m] = { tokens: { input: i, output: o, cache: c }, cost_usd: round4(cost) };
    }
    const residInput = Math.max(0, (u.input || 0) - input);
    const residCache = Math.max(0, (u.cache || 0) - cache);
    const residOutput = Math.max(0, (u.output || 0) - output);
    if (residInput || residCache || residOutput) {
        usd += calcCost(getModelPrice(provider, null), residInput, residCache, residOutput);
    }
    return { input: input + residInput, output: output + residOutput, cache: cache + residCache, usd, perModel };
}

function getUsageReport(provider, model) {
    if (provider && tokenUsage[provider]) {
        const u = tokenUsage[provider];
        if (model && u.models && u.models[model]) {
            const mu = u.models[model];
            const usd = calcCost(getModelPrice(provider, model), mu.input || 0, mu.cache || 0, mu.output || 0);
            return {
                provider,
                model,
                tokens: { input: mu.input || 0, output: mu.output || 0, cache: mu.cache || 0 },
                cost: { usd: round4(usd), brl: round2(usd * getUsdBrl()) }
            };
        }
        const agg = providerCost(provider);
        const usd = agg.usd;
        return {
            provider,
            model: '',
            tokens: { input: agg.input, output: agg.output, cache: agg.cache },
            cost: { usd: round4(usd), brl: round2(usd * getUsdBrl()) },
            perModel: agg.perModel
        };
    }
    let totalUSD = 0;
    const providers = {};
    for (const [p, u] of Object.entries(tokenUsage)) {
        const usd = providerCost(p).usd;
        providers[p] = { tokens: u, cost_usd: round4(usd), cost_brl: round2(usd * getUsdBrl()) };
        totalUSD += usd;
    }
    return { providers, total_brl: round2(totalUSD * getUsdBrl()) };
}

// Carrega estado persistido (preços salvos em disco e cotação) na inicialização.
loadTokenUsage();
try {
    const pricingFile = path.join(__dirname, 'pricing.json');
    if (fs.existsSync(pricingFile)) {
        const saved = JSON.parse(fs.readFileSync(pricingFile, 'utf-8'));
        if (saved.usdBrl) usdBrlRate = saved.usdBrl;
        if (saved.prices) Object.assign(TOKEN_PRICES, saved.prices);
    }
} catch (e) {}

module.exports = {
    TOKEN_PRICES, tokenUsage, round2, round4, getModelPrice, calcCost,
    providerCost, getUsageReport, trackTokens, savePricingFile,
    fetchUsdBrlRate, fetchAiPrices, getUsdBrl, setUsdBrl, setPricingDeps
};
