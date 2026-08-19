const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { McpManager } = require('./mcp-client');
const mcpManager = new McpManager();
const { browserClient, getBrowserStatus, executeBrowserTool } = require('./browser-client');

// ===== ENCODING UTF-8 (evita acentos corrompidos no console Windows) =====
process.stdout.setDefaultEncoding('utf8');
process.stderr.setDefaultEncoding('utf8');

const app = express();

// ===== ORIGEM LOCAL (CORS restrito + proteção contra DNS rebinding) =====
function isLocalOrigin(origin) {
    if (!origin || origin === 'null') return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

app.use(cors({
    origin(origin, cb) {
        if (isLocalOrigin(origin)) return cb(null, true);
        return cb(null, false);
    }
}));
app.use(express.json({ limit: '50mb' }));

// ===== SERVE O FRONTEND =====
const frontendDir = path.join(__dirname, '..', 'frontend');

// Injeta o token de autenticação no HTML para o modo navegador (iniciar-app.bat).
// Sem isso, o backend exigiria um token que o navegador não conhece.
app.get(['/', '/index.html'], (req, res) => {
    const indexPath = path.join(frontendDir, 'index.html');
    try {
        let html = fs.readFileSync(indexPath, 'utf-8');
        const marker = 'window.__BACKEND_TOKEN__';
        if (!html.includes(marker)) {
            const injection = `<script>window.__BACKEND_TOKEN__ = ${JSON.stringify(BACKEND_TOKEN)};</script>`;
            html = html.replace('</head>', injection + '</head>');
        }
        res.set('Cache-Control', 'no-store');
        res.type('html').send(html);
    } catch (e) {
        res.status(500).send('Erro ao carregar index.html');
    }
});

app.use(express.static(frontendDir));

const nodeModulesDir = path.join(__dirname, '..', 'node_modules');
app.use('/node_modules', express.static(nodeModulesDir));

// ===== SERVE ARQUIVOS DO PROJETO PARA O NAVEGADOR INTEGRADO =====
app.get('/project/*', (req, res) => {
    const relPath = req.params[0] || 'index.html';
    const full = resolveSafePath(relPath);
    if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return res.status(404).send('Arquivo não encontrado');
    }
    const relNormalized = relPath.replace(/\\/g, '/').toLowerCase();
    const sensitive = ['.env', 'config.json', '.git/config', '.gitignore', 'token_usage.json', 'pricing.json', 'aedificator.log'];
    if (sensitive.some(s => relNormalized === s || relNormalized.startsWith(s + '/') || relNormalized.includes('/' + s))) {
        return res.status(403).send('Arquivo protegido');
    }
    const ext = path.extname(full).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html', '.htm': 'text/html',
        '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
        '.json': 'application/json', '.svg': 'image/svg+xml',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
        '.txt': 'text/plain', '.md': 'text/markdown',
    };
    res.type(mimeTypes[ext] || 'application/octet-stream');
    res.sendFile(full);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Heartbeat: mantém conexões vivas durante tarefas longas (análises/instalações
// de vários minutos podem deixar o socket ocioso e derrubá-lo, perdendo o 'done'
// e travando a UI em "Enviando..."). Também detecta conexões mortas.
// Só inicia quando o servidor é o entrypoint (require.main) — quando o módulo é
// carregado por testes, o interval manteria o processo vivo e travaria o `npm test`.
let heartbeatInterval = null;
function startHeartbeat() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(() => {
        for (const client of wss.clients) {
            if (client.isAlive === false) {
                client.terminate();
                continue;
            }
            client.isAlive = false;
            client.ping();
        }
    }, 30000);
}

const runner = require('./runner');
const debuggerRunner = require('./debugger');
const analyzer = require('./analyzer');
const remote = require('./remote');

const PORT = process.env.PORT || 3001;

// Versão do protocolo do backend: usada pelo main.js para detectar um backend
// antigo ainda rodando na porta (o `isBackendRunning` reutilizaria um processo
// com bugs já corrigidos). Incremente ao mudar o comportamento do fluxo WS/API.
const BACKEND_PROTOCOL_VERSION = '4';

// =============================================
//  AUTENTICAÇÃO LOCAL
// =============================================
let BACKEND_TOKEN = process.env.BACKEND_TOKEN || '';

if (!BACKEND_TOKEN) {
    BACKEND_TOKEN = crypto.randomBytes(32).toString('hex');
    console.log('🔐 BACKEND_TOKEN não definido — token gerado automaticamente:');
    console.log(`   Token: ${BACKEND_TOKEN}`);
    console.log('   Todas as requisições /api exigem o header "Authorization: Bearer <token>" e toda mensagem WebSocket exige o campo "token".');
    console.log('   Defina BACKEND_TOKEN no backend/.env para fixar o valor.');
}

// ===== SEGREDO PARA CRIPTOGRAFAR AS CHAVES =====
const BACKEND_SECRET = process.env.BACKEND_SECRET || '';

app.use('/api', (req, res, next) => {
    const auth = req.headers['authorization'] || '';
    if (auth === `Bearer ${BACKEND_TOKEN}`) return next();
    return res.status(401).json({ error: 'Não autorizado' });
});

// =============================================
//  CRIPTOGRAFIA DAS CHAVES API
// =============================================
function encryptSecret(text) {
    if (!BACKEND_SECRET) return text;
    const key = crypto.createHash('sha256').update(BACKEND_SECRET).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptSecret(stored) {
    if (!stored) return '';
    if (BACKEND_SECRET && stored.startsWith('enc:v1:')) {
        try {
            const key = crypto.createHash('sha256').update(BACKEND_SECRET).digest();
            const data = Buffer.from(stored.slice(7), 'base64');
            const iv = data.subarray(0, 12);
            const tag = data.subarray(12, 28);
            const enc = data.subarray(28);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
        } catch (e) {
            console.log('⚠️ Não foi possível descriptografar a chave');
            return '';
        }
    }
    return stored;
}

// ===== PASTA PADRÃO DO PROJETO =====
let PROJECT_ROOT = process.env.PROJECT_ROOT || path.join(__dirname, 'projects');
let lastRepoInfo = null;

if (!fs.existsSync(PROJECT_ROOT)) {
    console.log(`⚠️ Pasta não encontrada: ${PROJECT_ROOT}`);
    PROJECT_ROOT = path.join(__dirname, 'projects');
    if (!fs.existsSync(PROJECT_ROOT)) {
        fs.mkdirSync(PROJECT_ROOT, { recursive: true });
    }
}

console.log(`📁 Diretório do projeto: ${PROJECT_ROOT}`);

// =============================================
//  FUNÇÃO PARA ATUALIZAR O DIRETÓRIO DO PROJETO
// =============================================
function setProjectRoot(newPath) {
    if (fileWatcher) { fileWatcher.close(); fileWatcher = null; }
    const resolvedPath = path.resolve(newPath);
    if (fs.existsSync(resolvedPath)) {
        PROJECT_ROOT = resolvedPath;
        lastRepoInfo = null;
        invalidateDeepseekCache();
        invalidateProjectCache();
        startFileWatcher();
        console.log(`📁 Diretório do projeto alterado para: ${PROJECT_ROOT}`);
        return true;
    }
    console.log(`❌ Diretório não encontrado: ${resolvedPath}`);
    return false;
}

// ===== LOGGER =====
const LOG_FILE = path.join(__dirname, 'aedificator.log');
const logBuffer = [];
const MAX_LOG_BUFFER = 300;

function logError(type, message, details) {
    const entry = {
        ts: new Date().toISOString(),
        type,
        message: String(message || '').slice(0, 500),
        details: details ? String(details).slice(0, 1000) : ''
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
    try {
        fs.appendFileSync(LOG_FILE, `[${entry.ts}] [${entry.type}] ${entry.message}${entry.details ? '\n  ' + entry.details : ''}\n`);
    } catch (e) {}
    broadcastLog(entry);
}

function broadcastLog(entry) {
    const payload = JSON.stringify({ type: 'log-entry', entry });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch (e) {}
        }
    }
}

// ===== CONFIGURAÇÃO =====
function sanitizeForJson(str) {
    if (!str) return '';
    let out = '';
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) continue;
        if (c === 0x7F) continue;
        if (c >= 0xD800 && c <= 0xDFFF) { out += '\uFFFD'; continue; }
        out += str[i];
    }
    return out;
}

function safeJsonStringify(obj) {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        const clean = JSON.parse(JSON.stringify(obj, (key, value) => {
            if (typeof value === 'string') return sanitizeForJson(value);
            return value;
        }));
        return JSON.stringify(clean);
    }
}

const OPENCODE_DEFAULT_MODEL = 'opencode/deepseek-v4-flash-free';

let config = {
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-3.5-flash'
    },
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'medium'
    },
    opencode: {
        apiKey: process.env.OPENCODE_API_KEY || '',
        model: OPENCODE_DEFAULT_MODEL
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-4o'
    },
    claude: {
        apiKey: process.env.ANTHROPIC_API_KEY || '',
        model: 'claude-sonnet-5'
    },
    autoCommit: true,
    toolPermissions: {
        ask: ['delete_file', 'file_rename', 'exec_command', 'git_commit', 'git_push', 'git_publish', 'docker_run', 'ssh_exec', 'snapshot_restore'],
        grants: {}
    }
};

const TOKEN_PRICES = {
    deepseek: {
        '__default': { input: 0.14, output: 0.28, cache: 0.0028 },
        models: {
            'deepseek-chat': { input: 0.27, output: 1.10, cache: 0.07 },
            'deepseek-reasoner': { input: 0.55, output: 2.19, cache: 0.14 },
            'deepseek-v4-flash': { input: 0.14, output: 0.28, cache: 0.0028 },
            'deepseek-v4-pro': { input: 0.435, output: 0.87, cache: 0.0036 }
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
let USD_TO_BRL = 5.80;
let _usdBrlLastFetch = 0;

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
        logError('json-parse', 'Erro ao salvar pricing.json', e.message);
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
            USD_TO_BRL = rate;
            _usdBrlLastFetch = now;
            console.log(`💲 Cotação USD/BRL atualizada: R$ ${rate}`);
            try {
                const pricingFile = path.join(__dirname, 'pricing.json');
                const saved = fs.existsSync(pricingFile) ? JSON.parse(fs.readFileSync(pricingFile, 'utf-8')) : {};
                saved.usdBrl = rate;
                savePricingFile(saved);
            } catch (e) { logError('json-parse', 'Erro ao salvar pricing.json', e.message); }
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
        logError('json-parse', 'Erro ao ler pricing.json', e.message);
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
        { name: 'Gemini', hasKey: !!config.gemini?.apiKey, call: (p) => callGemini(p, null, null) },
        { name: 'DeepSeek', hasKey: !!config.deepseek?.apiKey, call: (p) => callDeepSeek(p, null, null) },
        { name: 'OpenAI', hasKey: !!config.openai?.apiKey, call: (p) => callOpenAI(p, null, null) },
        { name: 'Claude', hasKey: !!config.claude?.apiKey, call: (p) => callClaude(p, null, null) }
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
            const newPrices = extractJson(response);
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
            logError('ai-prices', `Falha ao buscar preços via ${provider.name}`, e.message);
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
    try { fs.writeFileSync(usagePath, JSON.stringify(tokenUsage), 'utf-8'); } catch (e) {}
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
                cost: { usd: round4(usd), brl: round2(usd * USD_TO_BRL) }
            };
        }
        const agg = providerCost(provider);
        const usd = agg.usd;
        return {
            provider,
            model: '',
            tokens: { input: agg.input, output: agg.output, cache: agg.cache },
            cost: { usd: round4(usd), brl: round2(usd * USD_TO_BRL) },
            perModel: agg.perModel
        };
    }
    let totalUSD = 0;
    const providers = {};
    for (const [p, u] of Object.entries(tokenUsage)) {
        const usd = providerCost(p).usd;
        providers[p] = { tokens: u, cost_usd: round4(usd), cost_brl: round2(usd * USD_TO_BRL) };
        totalUSD += usd;
    }
    return { providers, total_brl: round2(totalUSD * USD_TO_BRL) };
}

loadTokenUsage();

const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (savedConfig.gemini?.apiKey) config.gemini.apiKey = decryptSecret(savedConfig.gemini.apiKey);
        if (savedConfig.gemini?.model) config.gemini.model = savedConfig.gemini.model;
        if (savedConfig.deepseek?.apiKey) config.deepseek.apiKey = decryptSecret(savedConfig.deepseek.apiKey);
        if (savedConfig.deepseek?.model) config.deepseek.model = normalizeDeepseekModel(savedConfig.deepseek.model);
        if (savedConfig.deepseek?.reasoningEffort) config.deepseek.reasoningEffort = savedConfig.deepseek.reasoningEffort;
        if (savedConfig.opencode?.apiKey) config.opencode.apiKey = decryptSecret(savedConfig.opencode.apiKey);
        if (savedConfig.opencode?.model) config.opencode.model = savedConfig.opencode.model;
        if (savedConfig.openai?.apiKey) config.openai.apiKey = decryptSecret(savedConfig.openai.apiKey);
        if (savedConfig.openai?.model) config.openai.model = savedConfig.openai.model;
        if (savedConfig.claude?.apiKey) config.claude.apiKey = decryptSecret(savedConfig.claude.apiKey);
        if (savedConfig.claude?.model) config.claude.model = savedConfig.claude.model;
        if (savedConfig.toolPermissions) {
            if (Array.isArray(savedConfig.toolPermissions.ask)) config.toolPermissions.ask = savedConfig.toolPermissions.ask;
            if (savedConfig.toolPermissions.grants && typeof savedConfig.toolPermissions.grants === 'object') config.toolPermissions.grants = savedConfig.toolPermissions.grants;
        }
        const undecrypted = ['gemini', 'deepseek', 'opencode', 'openai', 'claude'].filter(p =>
            savedConfig[p]?.apiKey && String(savedConfig[p].apiKey).startsWith('enc:v1:') && !config[p].apiKey
        );
        if (undecrypted.length) {
            console.log(`⚠️ ATENÇÃO: chaves de ${undecrypted.join(', ')} não puderam ser decifradas — possível divergência de BACKEND_SECRET entre .env e userData/.backend-secret.`);
        }
        console.log('✅ Configuração carregada');
    } catch (e) {
        console.log('⚠️ Erro ao carregar configuração');
        logError('json-parse', 'Erro ao carregar config.json', e.message);
    }
}

function saveConfigToFile() {
    let existing = {};
    try {
        if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {}

    // Se a chave em memória ficou vazia (ex.: secret divergente na carga),
    // preserva o valor criptografado já existente em disco em vez de sobrescrever com vazio.
    const encOr = (key, stored) => key ? encryptSecret(key) : (stored || '');

    const fileConfig = {
        gemini: { apiKey: encOr(config.gemini.apiKey, existing.gemini?.apiKey), model: config.gemini.model },
        deepseek: { apiKey: encOr(config.deepseek.apiKey, existing.deepseek?.apiKey), model: config.deepseek.model, reasoningEffort: config.deepseek.reasoningEffort },
        opencode: { apiKey: encOr(config.opencode.apiKey, existing.opencode?.apiKey), model: config.opencode.model },
        openai: { apiKey: encOr(config.openai.apiKey, existing.openai?.apiKey), model: config.openai.model },
        claude: { apiKey: encOr(config.claude.apiKey, existing.claude?.apiKey), model: config.claude.model },
        toolPermissions: config.toolPermissions
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
}

// =============================================
//  SISTEMA DE ARQUIVOS
// =============================================

const BACKUP_DIR_NAME = '.aedificator-codex-ide-backup';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', BACKUP_DIR_NAME]);
const MAX_CONTEXT_FILES = 500;
function toolResultMax() {
    // read_file/list_files/search_code retornam o conteúdo que o agente precisa
    // para ANALISAR — truncá-los faz a IA achar o arquivo "corrompido" e entrar
    // em loop. Só os resultados de escrita/edição (que voltam com o conteúdo
    // completo) são resumidos para economizar tokens.
    return _currentTaskComplexity === 'complex' ? 20000 : 12000;
}

// Aplica o corte por tamanho apenas a ferramentas de escrita, mantendo leitura
// e busca com conteúdo integral (essencial para análise correta).
function truncateToolResult(toolName, content) {
    if (['read_file', 'list_files', 'search_code', 'analyzer_symbols'].includes(toolName)) {
        return content;
    }
    return String(content).slice(0, toolResultMax());
}

function getProjectPath(relativePath) {
    if (!PROJECT_ROOT) return null;
    return path.join(PROJECT_ROOT, relativePath || '');
}

// ===== RESOLVE CAMINHO GARANTINDO QUE FICA DENTRO DO PROJETO =====
function resolveSafePath(relativePath) {
    if (!PROJECT_ROOT) return null;
    const root = path.resolve(PROJECT_ROOT);
    const resolved = path.resolve(root, relativePath || '');
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }
    return resolved;
}

// ===== VALIDAÇÃO DE COMANDOS DE SHELL (agente) =====
// Bloqueia encadeamento de comandos, redirecionamentos e substituição de
// comando. Ignora conteúdo entre aspas para não quebrar argumentos legítimos.
// Retorna null se o comando for seguro ou uma mensagem de erro caso contrário.
function validateAgentCommand(cmd) {
    const trimmed = String(cmd || '').trim();
    if (!trimmed) return 'Comando vazio';
    const stripped = trimmed.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    if (/[\r\n]/.test(trimmed)) return 'Comando bloqueado: quebras de linha não são permitidas';
    if (/[;|`]/.test(stripped)) return 'Comando bloqueado: separadores ; | ` não são permitidos';
    if (/&/.test(stripped)) return 'Comando bloqueado: encadeamento (&) não é permitido';
    if (/[<>]/.test(stripped)) return 'Comando bloqueado: redirecionamento (>) não é permitido';
    if (/\$\s*\(|\$\{/.test(stripped)) return 'Comando bloqueado: substituição de comando não é permitida';
    return null;
}

function readFileContent(filePath) {
    try {
        const fullPath = resolveSafePath(filePath);
        if (!fullPath || !fs.existsSync(fullPath)) {
            return null;
        }
        const raw = fs.readFileSync(fullPath, 'utf-8');
        return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    } catch (error) {
        return null;
    }
}

function buildFallbackSugestoes(task, aiText) {
    const cleanTask = task
        .replace(/^(crie|faça|implemente|ative|desenvolva|construa|cria|faz|implementa|ativa|desenvolve|constroi|ative)\s+/i, '')
        .replace(/^(um|uma|o|a|os|as|todos\s+os|todos)\s+/i, '')
        .trim()
        .slice(0, 80);

    function extractKeywords(text, maxLen) {
        if (!text) return cleanTask.slice(0, maxLen);
        const cleaned = text
            .replace(/^(📋\s*|\*\*|__|#+\s*)/gm, '')
            .replace(/\n{2,}/g, '. ')
            .replace(/\n/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        const sentences = cleaned.split(/[.!?]\s+/);
        const meaningful = sentences.filter(s => s.length > 15 && !/^(aqui|segue|vamos|iremos|primeiro|antes|depois|então|assim|dessa|nesse|neste)/i.test(s));
        if (meaningful.length >= 2) {
            return meaningful.slice(0, 2).join('. ').slice(0, maxLen);
        }
        return cleaned.slice(0, maxLen);
    }

    const context = extractKeywords(aiText, 120);
    const prefix = context && context !== cleanTask ? context + ' — ' : '';

    return {
        resumo: 'Como você quer implementar: ' + cleanTask + '?',
        sugestoes: [
            {
                id: 's1',
                titulo: '🔴 Completo: ' + cleanTask,
                descricao: 'Implementação robusta com validações, testes e cobertura total.',
                impacto: 'alto',
                arquivos: []
            },
            {
                id: 's2',
                titulo: '🟡 Médio: ' + cleanTask,
                descricao: 'Funcionalidades principais. Bom equilíbrio entre escopo e prazo.',
                impacto: 'médio',
                arquivos: []
            },
            {
                id: 's3',
                titulo: '🟢 Mínimo: ' + cleanTask,
                descricao: 'Apenas o essencial. Rápido de implementar.',
                impacto: 'baixo',
                arquivos: []
            },
            {
                id: 'custom',
                titulo: 'Personalizado',
                descricao: 'Descreva exatamente o que você deseja, com o nível de detalhe que preferir.',
                impacto: 'médio',
                arquivos: []
            }
        ]
    };
}

function writeFileContent(filePath, content) {
    try {
        const fullPath = resolveSafePath(filePath);
        if (!fullPath) {
            console.error(`❌ Caminho fora do projeto: ${filePath}`);
            return false;
        }
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, stripBOM(content), 'utf-8');
        invalidateProjectCache();
        console.log(`✅ Arquivo escrito: ${fullPath}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao escrever arquivo:', error);
        return false;
    }
}

function deleteFileContent(filePath) {
    try {
        const fullPath = resolveSafePath(filePath);
        if (!fullPath) return false;
        if (!fs.existsSync(fullPath)) return false;
        fs.unlinkSync(fullPath);
        invalidateProjectCache();
        return true;
    } catch (error) {
        return false;
    }
}

// ===== BACKUP VERSIONADO ANTES DE ALTERAR/APAGAR =====
const MAX_BACKUP_VERSIONS = 10;

function backupRelativePath(relativePath) {
    const fullPath = resolveSafePath(relativePath);
    if (!fullPath || !fs.existsSync(fullPath)) return null;
    const backupRoot = path.join(PROJECT_ROOT, BACKUP_DIR_NAME);
    const ts = Date.now();
    const backupFile = path.join(backupRoot, relativePath + '.' + ts);
    try {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.copyFileSync(fullPath, backupFile);
        trimOldBackups(relativePath);
        return backupFile;
    } catch (e) {
        console.error('❌ Erro ao fazer backup:', e);
        return null;
    }
}

function trimOldBackups(relativePath) {
    const backupRoot = path.join(PROJECT_ROOT, BACKUP_DIR_NAME);
    const dir = path.dirname(path.join(backupRoot, relativePath));
    if (!fs.existsSync(dir)) return;
    const versions = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const rel = path.join(path.dirname(relativePath), entry.name).replace(/\\/g, '/');
        const m = rel.match(/^(.*)\.(\d+)$/);
        if (m && m[1] === relativePath) {
            versions.push({ name: entry.name, mtime: fs.statSync(path.join(dir, entry.name)).mtimeMs });
        }
    }
    if (versions.length > MAX_BACKUP_VERSIONS) {
        versions.sort((a, b) => a.mtime - b.mtime);
        for (const v of versions.slice(0, versions.length - MAX_BACKUP_VERSIONS)) {
            try { fs.unlinkSync(path.join(dir, v.name)); } catch (e) { console.warn("Backup trim unlink:", e.message); }
        }
    }
}

function listBackups() {
    const backupRoot = path.join(PROJECT_ROOT, BACKUP_DIR_NAME);
    if (!fs.existsSync(backupRoot)) return [];
    const files = [];
    const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(full, relPath);
            } else {
                const m = relPath.match(/^(.*)\.(\d+)$/);
                files.push({
                    file: relPath,
                    path: m ? m[1] : relPath,
                    modified: fs.statSync(full).mtime.toISOString()
                });
            }
        }
    };
    walk(backupRoot, '');
    files.sort((a, b) => (a.path === b.path ? (a.modified < b.modified ? 1 : -1) : a.path.localeCompare(b.path)));
    return files;
}

// =============================================
//  LISTAR DIRETÓRIO (USA CAMINHO ABSOLUTO)
// =============================================
function listDirectory(dirPath) {
    try {
        // Se for caminho absoluto, usa diretamente
        const fullPath = path.isAbsolute(dirPath) ? dirPath : getProjectPath(dirPath);
        console.log(`📂 Listando: ${fullPath}`);
        if (!fs.existsSync(fullPath)) {
            console.log(`❌ Diretório não existe: ${fullPath}`);
            return [];
        }
        // Se o caminho aponta para um ARQUIVO (e não um diretório), o agente pode
        // ter passado o arquivo como "diretório" no search_code/list_files. Em vez
        // de lançar ENOTDIR (que fazia o agente não achar nada), retorna o arquivo
        // sozinho — resolve a causa do agente ficar preso explorando.
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
            const rel = path.relative(getProjectPath('') || PROJECT_ROOT, fullPath).replace(/\\/g, '/');
            return [{ name: path.basename(fullPath), isDirectory: false, path: rel, extension: path.extname(fullPath) }];
        }
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
            try {
                let isDir = entry.isDirectory();
                if (!isDir) {
                    try {
                        const target = path.join(fullPath, entry.name);
                        const st = fs.statSync(target);
                        isDir = st.isDirectory();
                    } catch (e) {}
                }
                result.push({
                    name: entry.name,
                    isDirectory: isDir,
                    path: path.join(dirPath, entry.name).replace(/\\/g, '/'),
                    extension: isDir ? '' : path.extname(entry.name)
                });
            } catch (e) {
                console.log(`⚠️ Ignorando item inacessível: ${entry.name}`);
            }
        }
        console.log(`✅ ${result.length} itens encontrados`);
        return result;
    } catch (error) {
        console.error('❌ Erro ao listar diretório:', error);
        return [];
    }
}

function getAllFiles(dirPath = '', count = { n: 0 }) {
    const files = [];
    if (count.n >= MAX_CONTEXT_FILES) return files;
    const items = listDirectory(dirPath);
    for (const item of items) {
        if (count.n >= MAX_CONTEXT_FILES) break;
        if (item.isDirectory) {
            if (IGNORED_DIRS.has(item.name)) continue;
            files.push(...getAllFiles(item.path, count));
        } else {
            count.n++;
            files.push(item.path);
        }
    }
    return files;
}

function getFileTree(dirPath = '', prefix = '', count = { n: 0 }) {
    const items = listDirectory(dirPath);
    let tree = '';
    for (const item of items) {
        if (count.n >= MAX_CONTEXT_FILES) break;
        if (item.isDirectory) {
            if (IGNORED_DIRS.has(item.name)) continue;
            tree += `${prefix}📂 ${item.name}\n`;
            tree += getFileTree(item.path, prefix + '  ', count);
        } else {
            count.n++;
            tree += `${prefix}📄 ${item.name}\n`;
        }
    }
    return tree;
}

// =============================================
//  FUNÇÕES DE IA
// =============================================

async function retryWithBackoff(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 15000, onRetry = null, signal = null } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal && signal.aborted) {
            const err = new Error('Tarefa cancelada');
            err.name = 'AbortError';
            throw err;
        }
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            const isRetryable = e.message?.includes('429') || e.message?.includes('500') || e.message?.includes('502') || e.message?.includes('503') || e.message?.includes('Limite de requisições') || e.message?.includes('rate') || e.message?.includes('timeout');
            if (!isRetryable || attempt >= maxRetries) throw e;
            const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
            if (onRetry) onRetry(attempt + 1, maxRetries, Math.round(delay / 1000));
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

function getProviderErrorHint(statusCode, errorBody, provider) {
    const msg = (errorBody || '').toLowerCase();
    if (statusCode === 401 || msg.includes('invalid api key') || msg.includes('incorrect api key') || msg.includes('unauthorized'))
        return `🔑 Chave API ${provider.toUpperCase()} inválida. Verifique em Configurações.`;
    if (statusCode === 402 || msg.includes('insufficient_quota') || msg.includes('billing') || msg.includes('credit') || msg.includes('balance'))
        return `💰 Créditos ${provider.toUpperCase()} esgotados. Recarregue no site do provedor.`;
    if (statusCode === 429 || msg.includes('rate limit') || msg.includes('too many requests'))
        return `⏳ Limite de requisições ${provider.toUpperCase()} atingido. Aguarde alguns minutos.`;
    if (statusCode === 403 || msg.includes('forbidden') || msg.includes('region'))
        return `🚫 Acesso negado à API ${provider.toUpperCase()}. Verifique permissões e região.`;
    if (statusCode >= 500)
        return `🔥 Servidor ${provider.toUpperCase()} instável. Tente novamente em alguns segundos.`;
    return '';
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000, externalSignal) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signals = [timeoutController.signal];
    if (externalSignal) signals.push(externalSignal);
    const combined = signals.length > 1 && typeof AbortSignal.any === 'function'
        ? AbortSignal.any(signals)
        : signals[0];
    try {
        return await fetch(url, { ...options, signal: combined });
    } finally {
        clearTimeout(timer);
    }
}

async function callGemini(prompt, onChunk, signal) {
    const apiKey = config.gemini.apiKey;
    const model = _currentTaskModel || config.gemini.model || 'gemini-3.5-flash';

    if (!apiKey) {
        throw new Error('Chave API Gemini não configurada!');
    }

    const useStream = !!onChunk;
    const url = useStream
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const parts = [];

    if (_pendingImages && _pendingImages.length) {
        for (const img of _pendingImages) {
            if (img.dataUrl) {
                const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)/);
                if (match) {
                    parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                }
            }
        }
        clearPendingImages();
    }

    parts.push({ text: prompt });

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: safeJsonStringify({
            contents: [{ parts }]
        })
    }, 120000, signal);

    if (!response.ok) {
        const error = await response.text();
        const hint = getProviderErrorHint(response.status, error, 'gemini');
        const msg = hint || `Erro na API Gemini: ${response.status} - ${error.slice(0, 300)}`;
        logError('gemini-api', msg, error.slice(0, 500));
        throw new Error(msg);
    }

    if (!useStream) {
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';
    }

    // ===== STREAMING REAL (SSE) =====
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let lastGeminiUsage = null;

    while (true) {
        if (signal && signal.aborted) {
            const err = new Error('Tarefa cancelada');
            err.name = 'AbortError';
            throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            try {
                const parsed = JSON.parse(data);
                const parts = parsed.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.text) {
                        fullResponse += part.text;
                        onChunk(part.text);
                    }
                }
                if (parsed.usageMetadata) lastGeminiUsage = parsed.usageMetadata;
            } catch (e) {}
        }
    }
    if (lastGeminiUsage) {
        const cacheHit = lastGeminiUsage.cachedContentTokenCount || 0;
        trackTokens('gemini', lastGeminiUsage.promptTokenCount || 0, lastGeminiUsage.candidatesTokenCount || 0, cacheHit > 0, model, cacheHit);
    }
    return fullResponse;
}

function resolveOpenCodeBinary() {
    if (process.platform !== 'win32') return 'opencode';
    const candidates = [
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'opencode', 'opencode.exe')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return 'opencode';
}

// ===== GARANTE CONFIG DO OPEncode USANDO APENAS MODELO FREE =====
function parseJsonC(text) {
    let out = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inLineComment) {
            if (ch === '\n') { inLineComment = false; out += ch; }
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inString) {
            out += ch;
            if (ch === '\\') { out += next || ''; i++; }
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; continue; }
        if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
        out += ch;
    }
    return out;
}

function ensureOpenCodeConfig() {
    try {
        const configDir = path.join(os.homedir(), '.config', 'opencode');
        const configFile = path.join(configDir, 'opencode.jsonc');
        let config = {};
        if (fs.existsSync(configFile)) {
            try {
                config = JSON.parse(parseJsonC(fs.readFileSync(configFile, 'utf-8')));
            } catch (e) {}
        }
        let changed = false;
        if (config.model !== OPENCODE_DEFAULT_MODEL) {
            config.model = OPENCODE_DEFAULT_MODEL;
            changed = true;
        }
        if (config.small_model !== OPENCODE_DEFAULT_MODEL) {
            config.small_model = OPENCODE_DEFAULT_MODEL;
            changed = true;
        }
        if (changed) {
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
            console.log(`✅ Config opencode atualizado para usar modelo free: ${configFile}`);
        }
    } catch (e) {
        console.log('⚠️ Não foi possível configurar o opencode automaticamente:', e.message);
    }
}

// ===== GRAVA A CHAVE API NO auth.json DO CLI OPEncode =====
function ensureOpenCodeAuth(apiKey) {
    try {
        if (!apiKey) return false;
        const dataDir = path.join(os.homedir(), '.local', 'share', 'opencode');
        const authFile = path.join(dataDir, 'auth.json');
        let auth = {};
        if (fs.existsSync(authFile)) {
            try {
                auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
            } catch (e) {}
        }
        let changed = false;
        if (auth.opencode?.key !== apiKey) {
            auth.opencode = { type: 'api', key: apiKey };
            changed = true;
        }
        if (changed) {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf-8');
            console.log('✅ Chave opencode Zen gravada no auth.json');
        }
        return true;
    } catch (e) {
        console.log('⚠️ Não foi possível gravar a chave opencode no auth.json:', e.message);
        return false;
    }
}

// ===== LÊ A CHAVE ATUAL DO CLI OPEncode =====
function getOpenCodeAuthKey() {
    try {
        const authFile = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
        if (!fs.existsSync(authFile)) return '';
        const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
        return auth.opencode?.key || '';
    } catch (e) {
        return '';
    }
}

// ===== LISTAR MODELOS OPEncode (TODOS ou apenas FREE) =====
function parseOpenCodeModelsVerbose(raw, allModels = false) {
    const models = [];
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].trim().match(/^opencode\/([\w.-]+)$/);
        if (!m) { i++; continue; }
        const shortId = m[1];
        let depth = 0, inString = false, started = false;
        const jsonLines = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const line = lines[j];
            jsonLines.push(line);
            for (let k = 0; k < line.length; k++) {
                const ch = line[k];
                if (inString) {
                    if (ch === '\\') { k++; continue; }
                    if (ch === '"') inString = false;
                } else if (ch === '"') {
                    inString = true;
                } else if (ch === '{') {
                    depth++;
                    started = true;
                } else if (ch === '}') {
                    depth--;
                    if (started && depth === 0) break;
                }
            }
            if (started && depth === 0) break;
        }
        try {
            const obj = JSON.parse(jsonLines.join('\n'));
            const name = obj.name || shortId;
            const isFree = /free/i.test(name) || /free/i.test(shortId);
            if (allModels || isFree) {
                models.push({ id: 'opencode/' + shortId, name, provider: 'opencode', free: isFree });
            }
        } catch (e) {}
        i = j + 1;
    }
    return models;
}

function parseTextOptions(text) {
    const lines = text.split('\n');
    const options = [];
    const seenIds = new Set();

    const letterPatterns = [
        /^([A-E])[.)]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/,
        /^(Op[cç][aã]o\s*\d+)[\s:.)-]+(.+?)(?:\s*[—–-]\s*(.+))?$/i,
        /^(\d+)[.)]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/
    ];

    let multiLine = null;
    for (const line of lines) {
        if (multiLine) {
            if (/^[A-E][.)]\s|^Op[cç][aã]o\s*\d+|^\d+[.)]\s|^Qual\s|^$|^[A-Z][a-z].*:$/.test(line.trim())) {
                options.push(multiLine);
                multiLine = null;
            } else {
                multiLine.descricao += ' ' + line.trim();
                continue;
            }
        }
        let matched = null;
        for (const pat of letterPatterns) {
            const m = line.match(pat);
            if (m) { matched = m; break; }
        }
        if (matched) {
            const id = 'oc' + (options.length + 1);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const titulo = (matched[1] + ': ' + (matched[2] || '')).trim().slice(0, 120);
            const desc = (matched[3] || matched[2] || '').trim().slice(0, 200);
            multiLine = { id, titulo, descricao: desc, impacto: 'médio', arquivos: [] };
        }
    }
    if (multiLine) options.push(multiLine);

    if (options.length < 2) {
        const categoryRegex = /^[A-Z][^:]{2,40}:\s*(.+)/;
        const seenTitles = new Set();
        for (const line of lines) {
            const m = line.match(categoryRegex);
            if (m) {
                const title = m[1].trim().slice(0, 100);
                if (title.length < 10 || seenTitles.has(title)) continue;
                seenTitles.add(title);
                const id = 'oc' + (options.length + 1);
                options.push({ id, titulo: title, descricao: title, impacto: 'médio', arquivos: [] });
            }
        }
    }

    if (options.length >= 2) {
        options.push({ id: 'custom', titulo: 'Personalizado', descricao: 'Descreva exatamente o que você deseja', impacto: 'médio', arquivos: [] });
    }
    return options;
}

function listOpenCodeFreeModels() {
    return listOpenCodeModels(false);
}

function listOpenCodeModels(allModels = false) {
    const binary = resolveOpenCodeBinary();
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(binary, ['models', 'opencode', '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            reject(new Error('Falha ao iniciar opencode: ' + e.message));
            return;
        }
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => reject(new Error('opencode não encontrado: ' + e.message)));
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error('opencode models falhou (code ' + code + '): ' + err.slice(0, 300)));
                return;
            }
            try {
                resolve(parseOpenCodeModelsVerbose(out, allModels));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ===== MONTA O PROMPT DO OPEncode COM MODO E HISTÓRICO =====
// Regra de idioma: todo diálogo do chat deve ser em português do Brasil.
const LANGUAGE_RULE = `
IDIOMA (OBRIGATÓRIO): Responda SEMPRE em português do Brasil (pt-BR), mesmo que o código, comentários ou trechos da conversa estejam em inglês. Use vocabulário brasileiro (ex.: "arquivo", "pasta", "executar", "teste").`;

function buildOpenCodePrompt(message, mode, history) {
    const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.cowork;
    const historyText = (history && history.length)
        ? history.slice(-15).map(h => `- ${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(h.content || '').slice(0, 800)}`).join('\n')
        : '(sem histórico)';

    return `Você é o Aedificator Codex IDE, um assistente de desenvolvimento prático que opera no diretório atual do projeto.
${LANGUAGE_RULE}

${getQualityRules()}

MODO ATIVO: ${modeInstruction}

SOLICITAÇÃO DO USUÁRIO: "${message}"

HISTÓRICO DA CONVERSA:
${historyText}

FERRAMENTAS DISPONÍVEIS NO APP (o app executa automaticamente após suas alterações):
- Diagnostics: JS/TS/Python/Go/C/C++/Rust — erros aparecem no painel "Problemas"
- Test Runner: executa testes automaticamente (Jest/pytest/go test/cargo test/make test)
- Code smells: detecta funções longas, vars não usadas, imports duplicados
- Git: commit/push/pull/diff — auto-commit após alterações sem erros
- Docker: containers, compose up/down — sidebar Docker
- Terminal: comandos shell locais. Prefixe com #remote para comandos SSH
- Build: npm build, make, cargo build, go build — detectado automaticamente
- Rollback: se houver erros críticos, alterações são revertidas automaticamente

CICLO DE TRABALHO: você analisa → executa → valida → responde. O usuário não vê modal de aprovação. Apenas faça.

COMPORTAMENTO:
- Se o pedido for claro: execute direto e responda com um resumo do que fez.
- Se o pedido for ambíguo (ex: "cria um app" sem dizer o que faz): PERGUNTE. Ex: "Que tipo de app? O que ele deve fazer?"
- Se for CRIAÇÃO de um app/sistema NOVO: primeiro crie um arquivo APP_SPEC.md com estrutura, telas, banco e stack. Depois implemente módulo por módulo.
- Se houver mais de uma forma técnica de resolver: ESCOLHA a mais simples e explique sua escolha rapidamente.
- Após alterar arquivos, responda com um resumo conversacional do que mudou.
- Se for só uma pergunta/análise, responda sem alterar arquivos.

LOOP DE AUTO-CORREÇÃO (OBRIGATÓRIO após modificar arquivos):
- Se o projeto tiver build/linter configurado: rode. Se houver erros, corrija e repita até passar.
- Se NÃO houver build configurado: pule. Não invente comandos.
- Se houver test runner: execute os testes. Se falharem, corrija e repita.

QUALIDADE (OBRIGATÓRIO ao finalizar cada módulo):
- Se houver test runner: GERE testes unitários para o código novo/modificado.
- Revise o código em busca de: tratamento de erro ausente, validação de entrada, SQL injection, XSS, secrets expostos, loops infinitos, memory leaks.
- Se encontrar algum problema de segurança ou robustez: corrija antes de entregar.
- Reporte no resumo: "Testes: X criados, Y passaram. Segurança: OK ou [lista de correções]".

AJUSTE FINO (OBRIGATÓRIO ao finalizar cada módulo):
- Após entregar o módulo, PERGUNTE: "Funcionou como esperado? Quer ajustar algo na interface ou no comportamento?"
- Se o usuário pedir ajuste de UI/UX (cores, layout, responsividade, fluxo): ajuste e peça feedback novamente.
- Itere até o usuário confirmar que está bom.

Execute a solicitação no diretório do projeto seguindo estas REGRAS:
- REGRA DE OURO: pode melhorar o código, mas funções existentes devem continuar funcionando com o mesmo comportamento.
- Só crie/modifique/delete arquivos se o usuário pedir EXPLICITAMENTE.
- NUNCA faça mudanças drásticas (refatorações grandes, reescritas completas) sem o usuário pedir.
- SEJA CONCISO: responda de forma curta e direta. Nada de explicações longas.`;
}

// ===== SNAPSHOT DOS ARQUIVOS PARA DETECTAR MUDANÇAS DO OPEncode =====
function snapshotProjectFiles() {
    const snapshot = new Map();
    const walk = (dir, rel) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            try {
                const st = fs.statSync(full);
                snapshot.set(relPath.replace(/\\/g, '/'), `${st.size}:${st.mtimeMs}`);
            } catch (e) {}
        }
    };
    walk(PROJECT_ROOT, '');
    return snapshot;
}

// ===== SNAPSHOT DO CONTEÚDO DOS ARQUIVOS (ANTES DO OPEncode) =====
function snapshotProjectContents() {
    const snapshot = new Map();
    const walk = (dir, rel) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            const full = path.join(dir, entry.name);
            try {
                const st = fs.statSync(full);
                if (st.size <= 3 * 1024 * 1024 && !isBinaryExtension(entry.name)) {
                    snapshot.set(relPath.replace(/\\/g, '/'), fs.readFileSync(full, 'utf-8'));
                }
            } catch (e) {}
        }
    };
    walk(PROJECT_ROOT, '');
    return snapshot;
}

// ===== CRIA BACKUP A PARTIR DE UM CONTEÚDO (versão anterior capturada) =====
function backupFromContent(relativePath, content) {
    if (!relativePath || typeof content !== 'string') return null;
    const backupRoot = path.join(PROJECT_ROOT, BACKUP_DIR_NAME);
    const ts = Date.now();
    const backupFile = path.join(backupRoot, relativePath + '.' + ts);
    try {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, content, 'utf-8');
        trimOldBackups(relativePath);
        console.log(`📦 Backup criado (opencode): ${relativePath}`);
        return backupFile;
    } catch (e) {
        console.error('❌ Erro ao fazer backup de conteúdo:', e);
        return null;
    }
}

// ===== BACKUP DE UM ARQUIVO EXISTENTE ANTES DE ALTERAR =====
function backupFileBeforeChange(relativePath) {
    return backupRelativePath(relativePath);
}

function diffSnapshots(before, after) {
    const changes = [];
    for (const [file, sig] of after) {
        const prev = before.get(file);
        if (prev === undefined) {
            changes.push({ file, action: 'criar', status: 'created' });
        } else if (prev !== sig) {
            changes.push({ file, action: 'modificar', status: 'modified' });
        }
    }
    for (const file of before.keys()) {
        if (!after.has(file)) {
            changes.push({ file, action: 'deletar', status: 'deleted' });
        }
    }
    return changes;
}

// Computa um diff linha a linha (LCS) entre dois textos e devolve uma lista de
// hunkes no formato: { type: 'add'|'del'|'ctx', line, oldLine, newLine }.
// Usado para exibir as edições do agente como diffs inline no chat, no estilo
// opencode/Antigravity.
function computeDiff(before, after) {
    const a = (before || '').replace(/\r\n/g, '\n').split('\n');
    const b = (after || '').replace(/\r\n/g, '\n').split('\n');
    if (a.length === 1 && a[0] === '') a.pop();
    if (b.length === 1 && b[0] === '') b.pop();

    const n = a.length, m = b.length;
    const dp = [];
    for (let i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
            else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            out.push({ type: 'ctx', line: a[i], oldLine: i + 1, newLine: j + 1 });
            i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', line: a[i], oldLine: i + 1 });
            i++;
        } else {
            out.push({ type: 'add', line: b[j], newLine: j + 1 });
            j++;
        }
    }
    while (i < n) { out.push({ type: 'del', line: a[i], oldLine: i + 1 }); i++; }
    while (j < m) { out.push({ type: 'add', line: b[j], newLine: j + 1 }); j++; }
    return out;
}

// Lê o conteúdo atual de um arquivo do projeto (string vazia se não existir).
function readProjectFileContent(relativePath) {
    try {
        const full = resolveSafePath(relativePath);
        if (!full || !fs.existsSync(full)) return '';
        const st = fs.statSync(full);
        if (st.size > 3 * 1024 * 1024) return '';
        return fs.readFileSync(full, 'utf-8');
    } catch (e) { return ''; }
}

function getToolIcon(toolName) {
    const t = (toolName || '').toLowerCase();
    const icons = {
        bash: '⚡', execute_command: '⚡', shell: '⚡',
        read: '📖', read_file: '📖',
        write: '✏️', write_file: '✏️', edit: '✏️',
        glob: '🔍', grep: '🔎',
        task: '🤖', agent: '🤖', subagent: '🤖',
        webfetch: '🌐', websearch: '🔎',
        todowrite: '📝', todo: '📝', question: '❓',
        skill: '🎯', lsp: '🔬',
        list_files: '📂', delete_file: '🗑️', search_code: '🔎',
        generate_tests: '🧪', exec_command: '⚡'
    };
    return icons[t] || '🔧';
}

function buildToolLabel(toolName, input) {
    const inp = input || {};
    const t = (toolName || '').toLowerCase();
    const cmd = inp.command || inp.cmd || inp.comando || '';
    const filePath = inp.filePath || inp.path || inp.file || inp.file_path || inp.caminho || '';
    const pattern = inp.pattern || inp.regex || inp.padrao || '';
    const desc = inp.description || inp.desc || inp.prompt || inp.descricao || '';
    const url = inp.url || '';
    const query = inp.query || '';
    const name = inp.name || '';
    const question = inp.question || inp.pergunta || '';
    if (!t || t.length < 2) {
        const firstArg = cmd || filePath || pattern || desc || url || '';
        return firstArg ? firstArg.slice(0, 50) : 'ferramenta';
    }
    switch (t) {
        case 'bash': case 'execute_command': case 'shell': case 'exec_command':
            return `Comando: ${(cmd || desc || '...').slice(0, 60)}`;
        case 'read': case 'read_file':
            return `Lendo: ${filePath.slice(0, 60) || 'arquivo'}`;
        case 'write': case 'write_file':
            return `Escrevendo: ${filePath.slice(0, 60) || 'arquivo'}`;
        case 'edit':
            return `Editando: ${filePath.slice(0, 60) || 'arquivo'}`;
        case 'glob':
            return `Buscando: ${pattern.slice(0, 60) || '*'}`;
        case 'grep':
            return `Procurando: "${(pattern || '').slice(0, 50)}"`;
        case 'webfetch':
            return `Acessando: ${(url || '').slice(0, 60)}`;
        case 'websearch':
            return `Pesquisando: ${(query || pattern || '').slice(0, 60)}`;
        case 'task': case 'agent': case 'subagent':
            return `Sub-agente: ${(desc || prompt || '').slice(0, 60)}`;
        case 'todowrite': case 'todo':
            return `Planejando tarefas`;
        case 'question':
            return `Perguntando: ${(question || '').slice(0, 60)}`;
        case 'skill':
            return `Skill: ${(name || '').slice(0, 60)}`;
        case 'list_files':
            return `Listando: ${(filePath || '').slice(0, 50) || 'raiz'}`;
        case 'delete_file':
            return `Deletando: ${filePath.slice(0, 60) || 'arquivo'}`;
        case 'search_code':
            return `Procurando: "${(pattern || '').slice(0, 50)}"`;
        case 'generate_tests':
            return `Gerando testes: ${filePath.slice(0, 50) || '...'}`;
        default:
            return `${toolName}: ${(desc || filePath || cmd || '').slice(0, 50) || '...'}`;
    }
}

let opencodeServerProcess = null;
let opencodeServerPort = null;

async function ensureOpenCodeServer() {
    if (opencodeServerProcess && !opencodeServerProcess.killed) return opencodeServerPort;
    const binary = resolveOpenCodeBinary();
    opencodeServerPort = 4099;
    const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' };
    opencodeServerProcess = spawn(binary, ['serve', '--port', String(opencodeServerPort), '--hostname', '127.0.0.1'], {
        cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env
    });
    opencodeServerProcess.on('exit', (code) => {
        console.log(`[opencode server] Encerrado (${code})`);
        opencodeServerProcess = null;
    });
    opencodeServerProcess.stderr.on('data', (d) => console.log(`[opencode server] ${d.toString().trim()}`));
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout opencode server')), 20000);
        const check = setInterval(async () => {
            try {
                const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/health`);
                if (resp.ok) { clearTimeout(timeout); clearInterval(check); resolve(); }
            } catch (e) {}
        }, 800);
    });
    console.log(`[opencode server] ✅ Pronto na porta ${opencodeServerPort}`);
    return opencodeServerPort;
}

function stopOpenCodeServer() {
    if (opencodeServerProcess) { opencodeServerProcess.kill(); opencodeServerProcess = null; }
}

async function callOpenCode(prompt, onChunk, signal, model, onToolEvent) {
    const binary = resolveOpenCodeBinary();
    ensureOpenCodeConfig();
    ensureOpenCodeAuth(config.opencode.apiKey);

    let useAttach = false;
    try { await ensureOpenCodeServer(); useAttach = true; } catch (e) {
        console.log(`[opencode] Server indisponível, usando modo direto: ${e.message}`);
    }

    const args = useAttach
        ? ['run', '--format', 'json', '--attach', `http://127.0.0.1:${opencodeServerPort}`, '--dir', PROJECT_ROOT]
        : ['run', '--format', 'json'];
    let useModel = model || _currentTaskModel || OPENCODE_DEFAULT_MODEL;
    if (!useModel.startsWith('opencode/') && !useModel.startsWith('opencode-go/')) {
        useModel = 'opencode/' + useModel;
    }
    args.push('--model', useModel);
    args.push('--title', 'Aedificator Codex IDE');
    args.push(prompt);
    let child;
    try {
        child = spawn(binary, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log(`[opencode] bin=${binary} args=${JSON.stringify(args)} cwd=${PROJECT_ROOT}`);
    } catch (e) {
        throw new Error('Falha ao iniciar opencode: ' + e.message);
    }

    let fullText = '';
    let buffer = '';
    let stderrBuf = '';
    let lastError = null;
    const timer = setTimeout(() => {
        try { child.kill(); } catch (e) {}
    }, 300000);

    return await new Promise((resolve, reject) => {
        child.stdout.on('data', (d) => {
            buffer += d.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const event = JSON.parse(trimmed);
                    let text = '';
                    if (event.type === 'error') {
                        const e = event.error || {};
                        lastError = e.data?.message || e.data?.error || e.message || e.detail ||
                            (typeof e.data === 'string' ? e.data : '') ||
                            (typeof e === 'string' ? e : JSON.stringify(e));
                        console.log(`[opencode error] ${lastError}`);
                        if (onChunk) onChunk('Sistema', `❌ ${lastError}\n`);
                    } else if (event.type === 'text' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
                        text = event.part.text;
                    } else if (event.type === 'message' && event.role === 'assistant') {
                        const content = event.content;
                        if (typeof content === 'string') {
                            text = content;
                        } else if (Array.isArray(content)) {
                            for (const part of content) {
                                if (part && typeof part === 'object') {
                                    if (typeof part.text === 'string') text += part.text;
                                    else if (part.type === 'text' && typeof part.content === 'string') text += part.content;
                                    else if (part.type === 'tool_use' && onToolEvent) {
                                        const toolName = part.name || part.tool || '';
                                        const toolId = part.id || part.tool_use_id || ('msg_tool_' + Date.now());
                                        const input = part.input || {};
                                        onToolEvent({
                                            ev: 'tool_start', id: toolId, tool: toolName,
                                            label: buildToolLabel(toolName, input), icon: getToolIcon(toolName),
                                            file: input.filePath || input.path || input.file || '',
                                            code: (toolName === 'write_file' || toolName === 'search_replace')
                                                ? String(input.content || input.code || input.newContent || '').slice(0, 4000)
                                                : ''
                                        });
                                    }
                                    else if (part.type === 'tool_result' && onToolEvent) {
                                        const toolId = part.tool_use_id || part.id || '';
                                        onToolEvent({ ev: 'tool_end', id: toolId, isError: !!(part.is_error || part.error) });
                                    }
                                }
                            }
                        }
                    }
                    if (onToolEvent) {
                        if (event.type === 'tool_use') {
                            const part = event.part || {};
                            const toolName = part.tool || event.tool || event.name || '';
                            const toolId = part.callID || event.id || event.tool_use_id || ('tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
                            const state = part.state || event.state || {};
                            const input = state.input || event.input || {};
                            onToolEvent({
                                ev: 'tool_start',
                                id: toolId,
                                tool: toolName,
                                label: buildToolLabel(toolName, input),
                                icon: getToolIcon(toolName),
                                file: input.filePath || input.path || input.file || '',
                                code: (toolName === 'write_file' || toolName === 'search_replace')
                                    ? String(input.content || input.code || input.newContent || '').slice(0, 4000)
                                    : ''
                            });
                        }
                        if (event.type === 'tool_result' || (event.tool_use_id && (event.content !== undefined || event.error !== undefined))) {
                            const toolId = event.tool_use_id || event.id || '';
                            const isError = !!(event.is_error || event.error);
                            onToolEvent({
                                ev: 'tool_end',
                                id: toolId,
                                isError,
                                error: isError ? ((event.error || '').toString().slice(0, 200)) : undefined
                            });
                        }
                    }
                    if (text) {
                        fullText += text;
                        if (onChunk) onChunk(text);
                    }
                } catch (e) {}
            }
        });
        child.stderr.on('data', (d) => {
            stderrBuf += d.toString();
            const msg = d.toString().trim();
            if (msg) console.log(`[opencode stderr] ${msg}`);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error('opencode não encontrado: ' + err.message));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (signal && signal.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
                return;
            }
            if (fullText.trim()) {
                const estimatedInput = Math.round(prompt.length / 4);
                const estimatedOutput = Math.round(fullText.length / 4);
                trackTokens('opencode', estimatedInput, estimatedOutput, false, useModel);
                if (lastError) {
                    const err = new Error(`opencode erro: ${lastError}`);
                    err.partialText = fullText.trim().slice(0, 500);
                    reject(err);
                } else {
                    resolve(fullText.trim());
                }
            } else if (code === 0) {
                resolve('');
            } else {
                const errDetail = lastError || stderrBuf.trim() || `código ${code} sem resposta`;
                reject(new Error(`opencode erro: ${errDetail.slice(0, 400)}`));
            }
        });
        if (signal) {
            signal.addEventListener('abort', () => {
                try { child.kill(); } catch (e) {}
            }, { once: true });
        }
    });
}

let _deepseekCachePrefix = '';
let _deepseekCacheKey = '';

function getDeepseekCachePrefix() {
    const key = PROJECT_ROOT + '|' + (config.deepseek.model || 'deepseek-chat');
    if (_deepseekCachePrefix && _deepseekCacheKey === key) return _deepseekCachePrefix;
    _deepseekCacheKey = key;
    _deepseekCachePrefix = getQualityRules() + '\nDIRETÓRIO: ' + PROJECT_ROOT + '\n';
    return _deepseekCachePrefix;
}

function invalidateDeepseekCache() {
    _deepseekCachePrefix = '';
    _deepseekCacheKey = '';
}

function normalizeDeepseekModel(model) {
    if (model === 'deepseek-chat') return 'deepseek-v4-flash';
    if (model === 'deepseek-reasoner') return 'deepseek-v4-flash';
    if (model === 'deepseek-v4-flash-free') return 'deepseek-v4-flash';
    return model;
}

async function callDeepSeek(prompt, onChunk, signal) {
    const apiKey = config.deepseek.apiKey;
    if (!apiKey) {
        throw new Error('Chave API DeepSeek não configurada!');
    }

    let finalPrompt = prompt;
    if (_pendingImages && _pendingImages.length) {
        finalPrompt = `[O usuário anexou ${_pendingImages.length} imagem(ns). O DeepSeek não suporta visão — use as instruções textuais do usuário.]\n\n${prompt}`;
        clearPendingImages();
    }

    const cachePrefix = getDeepseekCachePrefix();
    const model = _currentTaskModel || config.deepseek.model || 'deepseek-v4-flash';
    const url = 'https://api.deepseek.com/chat/completions';
    const safePrompt = sanitizeForJson(prompt);
    const safeSystem = sanitizeForJson(cachePrefix);
    const bodyObj = {
        model,
        messages: [
            { role: 'system', content: safeSystem },
            { role: 'user', content: safePrompt }
        ],
        stream: !!onChunk
    };
    if (model === 'deepseek-v4-pro') {
        bodyObj.reasoning_effort = config.deepseek.reasoningEffort || 'medium';
    }
    const body = safeJsonStringify(bodyObj);
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body
    }, 60000, signal);

    if (!response.ok) {
        const error = await response.text().catch(() => '');
        const statusCode = response.status;
        const hint = getProviderErrorHint(statusCode, error, 'deepseek');
        let errorMsg = hint || `Erro na API DeepSeek: ${statusCode}${error ? ' - ' + error.slice(0, 200) : ''}`;
        logError('deepseek-api', errorMsg, `status=${statusCode} body=${error.slice(0, 300)}`);
        throw new Error(errorMsg);
    }

    // Modo não-streaming (ex.: consulta de preços): a resposta é JSON único,
    // não SSE — basta ler e extrair a mensagem.
    if (!onChunk) {
        const data = await response.json().catch(() => null);
        if (!data) return '';
        const content = data.choices?.[0]?.message?.content || '';
        if (data.usage) {
            const cacheHit = data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0;
            trackTokens('deepseek', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cacheHit > 0, model, cacheHit);
        }
        return content;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let lastUsage = null;
    let reasoningBuf = '';
    let reasoningSent = false;

    while (true) {
        if (signal && signal.aborted) {
            const err = new Error('Tarefa cancelada');
            err.name = 'AbortError';
            throw err;
        }
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content || '';
                    const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
                    if (reasoning) reasoningBuf += reasoning;
                    if (content) {
                        if (reasoningBuf && !reasoningSent) {
                            reasoningSent = true;
                            if (onChunk) onChunk('reasoning', reasoningBuf);
                            fullResponse += `\n[🤔 raciocínio: ${reasoningBuf.slice(0, 200)}...]\n`;
                        }
                        fullResponse += content;
                        if (onChunk) onChunk('text', content);
                    }
                    if (parsed.usage) lastUsage = parsed.usage;
                } catch (e) {}
            }
        }
    }
    if (lastUsage) {
        const cacheHit = lastUsage.prompt_cache_hit_tokens || lastUsage.prompt_tokens_details?.cached_tokens || 0;
        trackTokens('deepseek', lastUsage.prompt_tokens || 0, lastUsage.completion_tokens || 0, cacheHit > 0, model, cacheHit);
    }
    return fullResponse;
}

async function callAI(provider, prompt, onChunk, signal, model) {
    if (provider === 'gemini') {
        return await callGemini(prompt, onChunk, signal, model);
    } else if (provider === 'deepseek') {
        return await callDeepSeek(prompt, onChunk, signal, model);
    } else if (provider === 'openai') {
        return await callOpenAI(prompt, onChunk, signal, model);
    } else if (provider === 'claude') {
        return await callClaude(prompt, onChunk, signal, model);
    } else if (provider === 'opencode') {
        return await callOpenCode(prompt, onChunk, signal, model);
    } else {
        throw new Error(`Provedor ${provider} não suportado`);
    }
}

// ===== OpenAI (ChatGPT) =====
async function callOpenAI(prompt, onChunk, signal) {
    const apiKey = config.openai.apiKey;
    if (!apiKey) throw new Error('Chave OpenAI não configurada');
    const model = _currentTaskModel || config.openai.model || 'gpt-4o';

    return new Promise((resolve, reject) => {
        const url = new URL('https://api.openai.com/v1/chat/completions');
        const userContent = [];
        const oaiImages = getImagePartsForOpenAI();
        if (oaiImages) {
            userContent.push(...oaiImages);
            clearPendingImages();
        }
        userContent.push({ type: 'text', text: prompt });
        const userMsg = oaiImages ? { role: 'user', content: userContent } : { role: 'user', content: prompt };

        const body = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: 'You are a coding assistant.' + LANGUAGE_RULE + ' Return valid JSON when requested.' },
                userMsg
            ],
            temperature: 0.3,
            stream: false
        });

        const abort = new AbortController();
        if (signal) signal.addEventListener('abort', () => abort.abort());

        fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body,
            signal: abort.signal
        }, 60000, abort.signal).then(async (res) => {
            if (!res.ok) {
                const err = await res.text();
                const hint = getProviderErrorHint(res.status, err, 'openai');
                const msg = hint || `OpenAI HTTP ${res.status}: ${err.slice(0, 200)}`;
                logError('openai-api', msg, err.slice(0, 500));
                throw new Error(msg);
            }
            const data = await res.json();
            const text = data.choices?.[0]?.message?.content || '';
            if (onChunk) onChunk(text);
            if (data.usage) trackTokens('openai', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, false, model);
            resolve(text);
        }).catch(reject);
    });
}

// ===== Anthropic (Claude) =====
async function callClaude(prompt, onChunk, signal, forcedModel) {
    const apiKey = config.claude.apiKey;
    if (!apiKey) throw new Error('Chave Claude não configurada');
    const model = forcedModel || _currentTaskModel || config.claude.model || 'claude-sonnet-5';

    return new Promise((resolve, reject) => {
        const url = new URL('https://api.anthropic.com/v1/messages');
        const userContent = [];
        const claudeImages = getImagePartsForClaude();
        if (claudeImages && claudeImages.length) {
            userContent.push(...claudeImages);
            clearPendingImages();
        }
        userContent.push({ type: 'text', text: prompt });
        const userMsg = claudeImages && claudeImages.length
            ? { role: 'user', content: userContent }
            : { role: 'user', content: prompt };

        const body = JSON.stringify({
            model,
            max_tokens: 4096,
            system: 'You are an IDE agent. You MUST respond ONLY with valid JSON. No explanations, no markdown, no conversation — just the JSON object. The response must start with { and end with }.',
            messages: [userMsg]
        });

        const abort = new AbortController();
        if (signal) signal.addEventListener('abort', () => abort.abort());

        fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body,
            signal: abort.signal
        }, 60000, abort.signal).then(async (res) => {
            if (!res.ok) {
                const err = await res.text();
                const hint = getProviderErrorHint(res.status, err, 'claude');
                const msg = hint || `Claude HTTP ${res.status}: ${err.slice(0, 200)}`;
                logError('claude-api', msg, err.slice(0, 500));
                throw new Error(msg);
            }
            const data = await res.json();
            const text = data.content?.[0]?.text || '';
            if (onChunk) onChunk(text);
            if (data.usage) {
            const cacheHit = data.usage.cache_read_input_tokens || 0;
            trackTokens('claude', data.usage.input_tokens || 0, data.usage.output_tokens || 0, cacheHit > 0, model, cacheHit);
        }
            resolve(text);
        }).catch(reject);
    });
}

// =============================================
//  PARSEAR JSON DA RESPOSTA DA IA
// =============================================
function extractJson(text) {
    if (!text) return null;
    var trimmed = text.trim();

    // Remove thinking/reasoning blocks (Claude extended thinking)
    trimmed = trimmed.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    trimmed = trimmed.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '');
    trimmed = trimmed.trim();

    try { return JSON.parse(trimmed); } catch (e) {}

    var fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()); } catch (e) {}
    }

    // Try to find the first complete JSON object
    var depth = 0;
    var start = -1;
    for (var i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '{' && depth === 0) { start = i; depth++; }
        else if (trimmed[i] === '{') { depth++; }
        else if (trimmed[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try { return JSON.parse(trimmed.slice(start, i + 1)); } catch (e) { start = -1; }
            }
        }
    }
    return null;
}

// =============================================
//  MODOS DE TRABALHO
// =============================================
const MODE_INSTRUCTIONS = {
    cowork: 'Modo Equipe (conservador): se o usuário fizer uma pergunta, análise ou pedir opinião/sugestões, responda no "resumo" e NÃO altere arquivos (deixe "arquivos" como []). Só crie/modifique/delete arquivos se o usuário pedir EXPLICITAMENTE. Nunca faça mudanças drásticas (refatorações grandes, reescritas completas, reorganização de pastas, criação de muitos arquivos) a menos que o usuário peça explicitamente. Prefira sempre alterações mínimas e localizadas.',
    autonomo: 'Modo Autônomo: você tem autonomia para planejar e executar. Analise o pedido, crie um plano de alterações e o backend executará automaticamente. SEMPRE retorne no Formato B (arquivos), nunca no Formato A (sugestoes). Faça as alterações necessárias para atender ao pedido. Seja prático e direto.',
    clarify: 'Modo Esclarecer: NÃO altere nenhum arquivo. Apenas faça perguntas de esclarecimento. Responda com um JSON onde "resumo" contém suas perguntas e "arquivos" é uma lista VAZIA [].',
    code: 'Modo Código: foque exclusivamente em código. Faça apenas as alterações mínimas necessárias e mantenha explicações curtas.',
    acp: 'Modo Arquitetura: foque na arquitetura do sistema. Prefira criar ou atualizar um documento de arquitetura (ex.: ARQUITETURA.md) descrevendo a solução, em vez de alterar código diretamente.',
    agent: 'Modo Agente: você tem acesso a ferramentas (ler arquivos, escrever, listar, executar comandos). Use-as livremente para explorar o código, fazer alterações e verificar o resultado. Itere até resolver o pedido. Seja prático e direto.'
};

// =============================================
//  MODO AGENTE — FERRAMENTAS
// =============================================
const TOOL_SCHEMAS = {
    read_file: {
        name: 'read_file',
        description: 'Lê o conteúdo completo de um arquivo do projeto. Retorna o conteúdo com diagnóstico de erros para arquivos de código.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a partir da raiz do projeto' } },
            required: ['caminho']
        }
    },
    write_file: {
        name: 'write_file',
        description: 'Cria ou sobrescreve um arquivo com o conteúdo completo. O diretório pai é criado automaticamente se não existir. Use para criar novos arquivos ou substituir arquivos existentes inteiros.',
        parameters: {
            type: 'object',
            properties: {
                caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser criado/modificado' },
                conteudo: { type: 'string', description: 'Conteúdo COMPLETO do arquivo' }
            },
            required: ['caminho', 'conteudo']
        }
    },
    delete_file: {
        name: 'delete_file',
        description: 'Remove um arquivo do projeto permanentemente.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser removido' } },
            required: ['caminho']
        }
    },
    list_files: {
        name: 'list_files',
        description: 'Lista arquivos e pastas de um diretório do projeto.',
        parameters: {
            type: 'object',
            properties: { diretorio: { type: 'string', description: 'Caminho relativo do diretório. Omita ou use "" para a raiz.' } },
            required: []
        }
    },
    search_code: {
        name: 'search_code',
        description: 'Busca por um padrão (regex) nos arquivos do projeto. Use para encontrar funções, classes, imports ou padrões de código.',
        parameters: {
            type: 'object',
            properties: {
                padrao: { type: 'string', description: 'Padrão regex para buscar no código' },
                diretorio: { type: 'string', description: 'Diretório onde buscar (opcional, padrão: raiz do projeto)' }
            },
            required: ['padrao']
        }
    },
    exec_command: {
        name: 'exec_command',
        description: 'Executa um comando shell no diretório do projeto. Use para rodar testes, builds, lint, npm/pip install, git commands não cobertos por outras tools, ou scripts de verificação.',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando shell completo a ser executado' } },
            required: ['comando']
        }
    },
    search_replace: {
        name: 'search_replace',
        description: 'Busca e substitui texto em arquivos do projeto. Mais eficiente que write_file para mudanças pontuais.',
        parameters: {
            type: 'object',
            properties: {
                padrao: { type: 'string', description: 'Texto exato a ser encontrado e substituído' },
                substituto: { type: 'string', description: 'Novo texto que substituirá o padrão' },
                caminho: { type: 'string', description: 'Arquivo ou diretório onde aplicar (opcional, padrão: todo o projeto)' }
            },
            required: ['padrao', 'substituto']
        }
    },
    file_rename: {
        name: 'file_rename',
        description: 'Renomeia ou move um arquivo/pasta do projeto.',
        parameters: {
            type: 'object',
            properties: {
                origem: { type: 'string', description: 'Caminho relativo atual do arquivo/pasta' },
                destino: { type: 'string', description: 'Novo caminho relativo' }
            },
            required: ['origem', 'destino']
        }
    },
    file_mkdir: {
        name: 'file_mkdir',
        description: 'Cria um diretório (e diretórios pais se necessário).',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do diretório a ser criado' } },
            required: ['caminho']
        }
    },
    analyzer_validate: {
        name: 'analyzer_validate',
        description: 'Valida um arquivo de código e retorna erros e avisos de sintaxe/lint.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser validado' } },
            required: ['caminho']
        }
    },
    analyzer_symbols: {
        name: 'analyzer_symbols',
        description: 'Extrai símbolos (funções, classes, variáveis, imports) de um arquivo de código.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo' } },
            required: ['caminho']
        }
    },
    test_run: {
        name: 'test_run',
        description: 'Executa os testes do projeto (jest, pytest, go test, cargo test) e retorna o resultado.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    undo: {
        name: 'undo',
        description: 'Desfaz a última alteração de arquivo feita pelo agente. Use se cometeu um erro.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    redo: {
        name: 'redo',
        description: 'Refaz a última alteração desfeita pelo undo.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    generate_tests: {
        name: 'generate_tests',
        description: 'Gera testes unitários para um arquivo de código existente e executa os testes.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo para gerar testes' } },
            required: ['caminho']
        }
    },
    browser_navigate: {
        name: 'browser_navigate',
        description: 'Navega o browser Playwright para uma URL. Use para testar frontend web.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'URL completa para navegar (ex: http://localhost:3000)' } },
            required: ['url']
        }
    },
    browser_screenshot: {
        name: 'browser_screenshot',
        description: 'Tira um screenshot da página atual do browser.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    browser_click: {
        name: 'browser_click',
        description: 'Clica em um elemento CSS na página do browser.',
        parameters: {
            type: 'object',
            properties: { selector: { type: 'string', description: 'Seletor CSS do elemento a clicar' } },
            required: ['selector']
        }
    },
    browser_type: {
        name: 'browser_type',
        description: 'Digita texto em um campo input/textarea na página do browser.',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Seletor CSS do campo input/textarea' },
                text: { type: 'string', description: 'Texto a ser digitado' }
            },
            required: ['selector', 'text']
        }
    },
    browser_evaluate: {
        name: 'browser_evaluate',
        description: 'Executa JavaScript na página do browser e retorna o resultado.',
        parameters: {
            type: 'object',
            properties: { js: { type: 'string', description: 'Código JavaScript a ser executado na página' } },
            required: ['js']
        }
    },
    browser_console: {
        name: 'browser_console',
        description: 'Lê os logs do console do browser atual.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    browser_content: {
        name: 'browser_content',
        description: 'Obtém o conteúdo HTML completo da página atual do browser.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_publish: {
        name: 'git_publish',
        description: 'Publica uma release: faz commit, cria tag semver e push. Use após concluir uma feature.',
        parameters: {
            type: 'object',
            properties: { mensagem: { type: 'string', description: 'Mensagem do commit (opcional)' } },
            required: []
        }
    },
    git_status: {
        name: 'git_status',
        description: 'Mostra o status do git (arquivos modificados, staged, untracked).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_diff: {
        name: 'git_diff',
        description: 'Mostra o diff das alterações atuais (unstaged).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_log: {
        name: 'git_log',
        description: 'Mostra histórico de commits (últimos 10).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_commit: {
        name: 'git_commit',
        description: 'Faz commit das alterações staged. Use git_status antes para ver o que será commitado.',
        parameters: {
            type: 'object',
            properties: { mensagem: { type: 'string', description: 'Mensagem descritiva do commit' } },
            required: ['mensagem']
        }
    },
    git_push: {
        name: 'git_push',
        description: 'Faz push dos commits para o remote.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_pull: {
        name: 'git_pull',
        description: 'Faz pull das alterações do remote.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_branch: {
        name: 'git_branch',
        description: 'Lista branches locais e remotas.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_stash: {
        name: 'git_stash',
        description: 'Salva ou restaura alterações não commitadas no stash.',
        parameters: {
            type: 'object',
            properties: { acao: { type: 'string', description: '"push" para salvar ou "pop" para restaurar' } },
            required: ['acao']
        }
    },
    snapshot_create: {
        name: 'snapshot_create',
        description: 'Cria um snapshot completo do estado atual do projeto para backup.',
        parameters: {
            type: 'object',
            properties: { rotulo: { type: 'string', description: 'Nome descritivo do snapshot (opcional)' } },
            required: []
        }
    },
    snapshot_list: {
        name: 'snapshot_list',
        description: 'Lista todos os snapshots salvos do projeto.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    snapshot_restore: {
        name: 'snapshot_restore',
        description: 'Restaura o projeto para um snapshot anterior. CUIDADO: desfaz todas as alterações posteriores.',
        parameters: {
            type: 'object',
            properties: { rotulo: { type: 'string', description: 'Nome do snapshot para restaurar' } },
            required: ['rotulo']
        }
    },
    debug_start: {
        name: 'debug_start',
        description: 'Inicia uma sessão de debug Node.js para um arquivo.',
        parameters: {
            type: 'object',
            properties: { arquivo: { type: 'string', description: 'Caminho do arquivo para debugar' } },
            required: ['arquivo']
        }
    },
    debug_stop: {
        name: 'debug_stop',
        description: 'Para a sessão de debug atual.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    debug_step: {
        name: 'debug_step',
        description: 'Avança um passo no debug (step over).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    debug_resume: {
        name: 'debug_resume',
        description: 'Continua a execução até o próximo breakpoint.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    ssh_exec: {
        name: 'ssh_exec',
        description: 'Executa um comando no servidor remoto via SSH. Requer conexão SSH ativa.',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando a ser executado no servidor remoto' } },
            required: ['comando']
        }
    },
    ssh_status: {
        name: 'ssh_status',
        description: 'Verifica o status da conexão SSH com o servidor remoto.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    docker_run: {
        name: 'docker_run',
        description: 'Executa um container Docker com a imagem especificada. O comando deve começar com "docker".',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando docker completo' } },
            required: ['comando']
        }
    },
    task: {
        name: 'task',
        description: 'Delega uma subtarefa a um subagente isolado (somente leitura) que investiga o projeto e retorna um resumo. Use para buscas complexas, exploração de código ou análises paralelas sem poluir o contexto do agente principal.',
        parameters: {
            type: 'object',
            properties: { descricao: { type: 'string', description: 'Descrição detalhada da subtarefa a ser executada pelo subagente' } },
            required: ['descricao']
        }
    },
    question: {
        name: 'question',
        description: 'Faz uma pergunta ao usuário e aguarda a resposta. Use quando precisar de uma decisão, esclarecimento ou preferência do usuário durante a execução.',
        parameters: {
            type: 'object',
            properties: { pergunta: { type: 'string', description: 'A pergunta a ser feita ao usuário' } },
            required: ['pergunta']
        }
    },
    todo: {
        name: 'todo',
        description: 'Cria ou atualiza a lista de tarefas do plano atual. Use para expor um plano rastreável do trabalho em andamento.',
        parameters: {
            type: 'object',
            properties: {
                tarefas: {
                    type: 'array',
                    description: 'Lista de tarefas, cada uma como { "titulo": "...", "status": "pending|in_progress|completed" }',
                    items: { type: 'object', properties: { titulo: { type: 'string' }, status: { type: 'string' } } }
                }
            },
            required: ['tarefas']
        }
    }
};

const AGENT_TOOLS = Object.values(TOOL_SCHEMAS).map(t => ({
    name: t.name,
    description: t.description,
    parameters: Object.fromEntries(
        Object.entries(t.parameters.properties || {}).map(([k, v]) => [k, v.description || v.type || 'string'])
    )
}));

function stripBOM(text) {
    return typeof text === 'string' ? text.replace(/^\uFEFF+/, '') : text;
}

function normalizeLine(line) {
    return line.trim().replace(/\s+/g, ' ');
}

function replaceIgnoringIndent(content, pattern, replacement) {
    const pLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (!pLines.length) return content;
    const pNormalized = pLines.map(normalizeLine);
    const cLines = content.split('\n');
    for (let i = 0; i <= cLines.length - pLines.length; i++) {
        let ok = true;
        for (let j = 0; j < pLines.length; j++) {
            if (normalizeLine(cLines[i + j]) !== pNormalized[j]) { ok = false; break; }
        }
        if (ok) {
            const indent = (cLines[i].match(/^\s*/) || [''])[0];
            const rLines = replacement.split('\n').map((l, idx) => idx === 0 ? indent + l.trim() : l);
            cLines.splice(i, pLines.length, ...rLines);
            return cLines.join('\n');
        }
    }
    return content;
}

function replaceInContent(content, pattern, replacement) {
    if (content.includes(pattern)) {
        return { content: content.split(pattern).join(replacement), matched: true };
    }
    let matched = false;
    try {
        const regex = new RegExp(pattern, 'g');
        const replaced = content.replace(regex, replacement);
        if (replaced !== content) { content = replaced; matched = true; }
    } catch (e) {}
    if (!matched) {
        const normalized = replaceIgnoringIndent(content, pattern, replacement);
        if (normalized !== content) { content = normalized; matched = true; }
    }
    if (!matched) {
        const lines = content.split('\n');
        const pLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let found = false;
        for (let i = 0; i < lines.length && !found; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            for (const p of pLines) {
                if (p && trimmed.includes(p)) {
                    lines[i] = lines[i].replace(p, replacement.trim());
                    found = true;
                    break;
                }
            }
        }
        if (found) { content = lines.join('\n'); matched = true; }
    }
    return { content, matched };
}

async function executeAgentTool(name, args) {
    switch (name) {
        case 'read_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
            const content = stripBOM(fs.readFileSync(full, 'utf-8')).slice(0, 50000);
            // Retorna o conteúdo limpo, como o opencode — sem o bloco de
            // diagnóstico que inflava o contexto e fazia o modelo ficar
            // "analisando" em vez de corrigir. A validação acontece no
            // write_file/analyzer_validate, não a cada leitura.
            return content;
        }
        case 'write_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full) return 'Erro: caminho inválido';
            const dir = path.dirname(full);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cleanContent = stripBOM(args.conteudo || '');
            fs.writeFileSync(full, cleanContent, 'utf-8');
            const ext = path.extname(args.caminho).toLowerCase();
            let result = `Arquivo ${args.caminho} salvo (${cleanContent.length} bytes)`;
            if (['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.c', '.cpp', '.h'].includes(ext)) {
                try {
                    const validation = analyzer.validateCode(cleanContent, args.caminho, PROJECT_ROOT);
                    const errs = validation.errors.filter(e => e.severity === 'error');
                    const warns = validation.errors.filter(e => e.severity === 'warning');
                    if (errs.length > 0) result += `\n⚠️ ${errs.length} erro(s): ${errs.slice(0, 5).map(e => `Ln ${e.line}: ${e.message}`).join('; ')}`;
                    if (warns.length > 0) result += `\n💡 ${warns.length} aviso(s): ${warns.slice(0, 3).map(e => `Ln ${e.line}: ${e.message}`).join('; ')}`;
                    if (validation.errors.length === 0) result += ' ✅ Validação OK';
                } catch (e) {}
            }
            try {
                const testResult = runQuickTest(args.caminho);
                if (testResult) result += '\n' + testResult;
            } catch (e) {}
            return result;
        }
        case 'delete_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
            fs.unlinkSync(full);
            return `Arquivo ${args.caminho} removido`;
        }
        case 'list_files': {
            const dir = args.diretorio || '';
            const safeDir = resolveSafePath(dir);
            if (!safeDir) return 'Erro: diretório inválido (fora do projeto)';
            const items = listDirectory(safeDir);
            return items.map(i => `${i.isDirectory ? '📂' : '📄'} ${i.name}`).join('\n') || '(vazio)';
        }
        case 'search_code': {
            const dir = args.diretorio || '';
            const basePath = resolveSafePath(dir);
            if (!basePath) return 'Erro: diretório inválido';
            const pattern = args.padrao || '';
            if (!pattern) return 'Erro: padrão vazio';
            const results = [];
            try {
                const allFiles = getAllFiles(basePath, { n: 0 });
                // Padrão "gi" é stateful (flag g guarda lastIndex entre test()).
                // Reinspeita a regex para cada linha, senão test() pula resultados
                // e o search_code volta "Nenhum resultado" para padrões que existem.
                const re = new RegExp(pattern, 'gi');
                // Padrões com [\s\S] indicam busca multiline (trechos de código
                // multi-linha). Esses precisam rodar contra o arquivo inteiro,
                // não linha a linha.
                const multiline = /\[\\s\\S\]/.test(pattern);
                for (const file of allFiles.slice(0, 200)) {
                    try {
                        // getAllFiles devolve caminho relativo à raiz do projeto.
                        // Sem o join abaixo o readFileSync falha (path relativo ao
                        // cwd) e o search_code voltava "Nenhum resultado" sempre.
                        const abs = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
                        const content = fs.readFileSync(abs, 'utf-8');
                        if (multiline) {
                            re.lastIndex = 0;
                            const m = re.exec(content);
                            if (m) {
                                const ln = content.slice(0, m.index).split('\n').length;
                                results.push(`${path.relative(PROJECT_ROOT, abs)}:${ln}: ${m[0].trim().slice(0, 200)}`);
                                if (results.length >= 30) break;
                            }
                            continue;
                        }
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            re.lastIndex = 0;
                            if (re.test(lines[i])) {
                                results.push(`${path.relative(PROJECT_ROOT, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                                if (results.length >= 30) break;
                            }
                        }
                    } catch (e) {}
                    if (results.length >= 30) break;
                }
            } catch (e) { return 'Erro ao buscar: ' + e.message; }
            return results.join('\n') || 'Nenhum resultado encontrado';
        }
        case 'exec_command': {
            const cmd = args.comando || '';
            const validationError = validateAgentCommand(cmd);
            if (validationError) return `Erro: ${validationError}`;
            try {
                if (agentStreamCallback) {
                    agentStreamCallback('Sistema', `$ ${cmd}\n`);
                    const chunks = [];
                    const child = require('child_process').spawn(cmd, [], { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
                    registerChildProcess(child);
                    const killTimer = setTimeout(() => killChildTree(child), 30000);
                    child.stdout.on('data', (d) => {
                        const text = d.toString();
                        chunks.push(text);
                        agentStreamCallback('Sistema', text);
                    });
                    child.stderr.on('data', (d) => {
                        const text = d.toString();
                        chunks.push(text);
                        agentStreamCallback('Sistema', text);
                    });
                    const code = await new Promise((resolve) => {
                        child.on('close', (c) => { clearTimeout(killTimer); resolve(c); });
                        child.on('error', () => { clearTimeout(killTimer); resolve(-1); });
                    });
                    const output = chunks.join('').slice(0, 10000);
                    return code === 0 ? (output || '(sem saída)') : `Erro (código ${code}): ${output.slice(0, 2000)}`;
                } else {
                    const result = require('child_process').execSync(cmd, { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
                    return result.slice(0, 10000) || '(sem saída)';
                }
            } catch (e) {
                return `Erro (código ${e.status}): ${(e.stderr || e.message || '').slice(0, 2000)}`;
            }
        }
        case 'generate_tests': {
            const full = resolveSafePath(args.caminho || '');
            if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
            const content = fs.readFileSync(full, 'utf-8');
            const ext = path.extname(args.caminho).toLowerCase();
            const testPath = getTestFilePath(args.caminho);
            if (fs.existsSync(path.join(PROJECT_ROOT, testPath))) return `Arquivo de teste já existe: ${testPath}`;
            const testPrompt = buildTestPrompt(args.caminho, content, ext);
            const provider = 'gemini';
            try {
                const testCode = await callAI(provider, testPrompt, null, null);
                const cleanCode = testCode.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
                if (!cleanCode || cleanCode.length < 20) return 'Erro: IA não gerou código de teste';
                const testFull = path.join(PROJECT_ROOT, testPath);
                const testDir = path.dirname(testFull);
                if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
                fs.writeFileSync(testFull, cleanCode, 'utf-8');
                const testResult = runQuickTest(args.caminho);
                return `✅ Teste criado: ${testPath}\n${testResult || 'Teste executado'}`;
            } catch (e) {
                return `Erro ao gerar testes: ${e.message}`;
            }
        }
        case 'git_publish': {
            try {
                const status = await runGit(['status', '--porcelain'], PROJECT_ROOT);
                if (status.code !== 0) return 'Erro: git não encontrado ou projeto não é repositório';
                const hasChanges = status.output.trim().length > 0;
                const tag = nextVersion(await latestVersionTag());
                const commitMsg = args.mensagem || `🔖 versão ${tag}`;
                if (hasChanges) {
                    await runGit(['add', '-A'], PROJECT_ROOT);
                    await runGit(['commit', '-m', commitMsg], PROJECT_ROOT);
                }
                await runGit(['tag', '-a', tag, '-m', `Release ${tag}`], PROJECT_ROOT);
                await runGit(['push', 'origin', 'HEAD', '--follow-tags'], PROJECT_ROOT);
                return `✅ Release ${tag} publicada! ${hasChanges ? '(com alterações commitadas)' : '(sem novas alterações)'}`;
            } catch (e) {
                return `Erro ao publicar: ${e.message}`;
            }
        }
        case 'git_status': {
            try { const r = await runGit(['status'], PROJECT_ROOT); return r.output.trim() || '(working tree limpa)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_diff': {
            try { const r = await runGit(['diff'], PROJECT_ROOT); return r.output.slice(0, 5000).trim() || '(sem alterações)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_log': {
            try { const r = await runGit(['log', '--oneline', '-10'], PROJECT_ROOT); return r.output.trim() || '(sem commits)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_commit': {
            try { await runGit(['add', '-A'], PROJECT_ROOT); const r = await runGit(['commit', '-m', args.mensagem || 'commit'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_push': {
            try { const r = await runGit(['push'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_pull': {
            try { const r = await runGit(['pull'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_branch': {
            try { const r = await runGit(['branch', '-a'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'git_stash': {
            try { const r = await runGit(['stash', args.acao || 'push'], PROJECT_ROOT); return r.output.trim() || 'ok'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'file_rename': {
            const src = resolveSafePath(args.origem || '');
            const dst = resolveSafePath(args.destino || '');
            if (!src || !dst) return 'Erro: caminho inválido';
            if (!fs.existsSync(src)) return 'Erro: arquivo origem não encontrado';
            try { fs.renameSync(src, dst); return `Renomeado: ${args.origem} → ${args.destino}`; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'file_mkdir': {
            const dir = resolveSafePath(args.caminho || '');
            if (!dir) return 'Erro: caminho inválido';
            try { fs.mkdirSync(dir, { recursive: true }); return `Diretório criado: ${args.caminho}`; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'analyzer_validate': {
            const f = resolveSafePath(args.caminho || '');
            if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
            try { const content = fs.readFileSync(f, 'utf-8'); const v = analyzer.validateCode(content, args.caminho, PROJECT_ROOT); return v.errors.length ? v.errors.slice(0, 20).map(e => `Ln ${e.line}: [${e.severity}] ${e.message}`).join('\n') : '✅ Nenhum erro encontrado'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'analyzer_symbols': {
            const f = resolveSafePath(args.caminho || '');
            if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
            try { const content = fs.readFileSync(f, 'utf-8'); const ext = path.extname(args.caminho).toLowerCase(); let sym = []; if (['.js','.ts','.jsx','.tsx'].includes(ext)) sym = analyzer.getTSSymbols(args.caminho, PROJECT_ROOT); else if (ext === '.py') sym = analyzer.getPythonSymbols(args.caminho, PROJECT_ROOT); else if (ext === '.go') sym = analyzer.getGoSymbols(args.caminho, PROJECT_ROOT); return sym.map(s => `${s.kind} ${s.name} (ln ${s.line})`).join('\n') || '(nenhum símbolo)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'test_run': {
            try { const result = runner.runCommandSync ? runner.runCommandSync('npm test', { cwd: PROJECT_ROOT, timeoutMs: 60000 }) : await runner.runCommand({ command: 'npm test', cwd: PROJECT_ROOT, timeoutMs: 60000 }); const r = result.stdout || result.output || ''; return r.slice(0, 5000).trim() || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'snapshot_create': {
            try { const label = args.rotulo || `snapshot-${Date.now()}`; const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots', label); if (fs.existsSync(snapDir)) return 'Erro: snapshot já existe com esse rótulo'; fs.mkdirSync(snapDir, { recursive: true }); copyDirContents(PROJECT_ROOT, snapDir, new Set(['node_modules', '.git', 'dist', 'build', BACKUP_DIR_NAME])); return `✅ Snapshot '${label}' criado`; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'snapshot_list': {
            try { const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots'); if (!fs.existsSync(snapDir)) return '(nenhum snapshot)'; return fs.readdirSync(snapDir).map(d => { const stat = fs.statSync(path.join(snapDir, d)); return `${d} (${stat.mtime.toISOString().slice(0, 10)})`; }).join('\n') || '(nenhum snapshot)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'snapshot_restore': {
            try { const label = args.rotulo; if (!label) return 'Erro: informe o rótulo do snapshot'; const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots', label); if (!fs.existsSync(snapDir)) return 'Erro: snapshot não encontrado'; restoreSnapshot(label); return `✅ Projeto restaurado para snapshot '${label}'`; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'debug_start': {
            try { const f = resolveSafePath(args.arquivo || ''); if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado'; if (debuggerRunner.isRunning()) return 'Erro: já existe debug ativo'; await debuggerRunner.startDebug({ file: f, onEvent: () => {} }); return `✅ Debug iniciado: ${args.arquivo}`; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'debug_stop': {
            try { const r = debuggerRunner.stopDebug(); return r ? '✅ Debug parado' : 'Nenhum debug ativo'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'debug_step': {
            try { if (!debuggerRunner.isRunning()) return 'Erro: nenhum debug ativo'; const r = await debuggerRunner.stepOver(); return JSON.stringify(r); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'debug_resume': {
            try { if (!debuggerRunner.isRunning()) return 'Erro: nenhum debug ativo'; const r = await debuggerRunner.resume(); return JSON.stringify(r); } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'ssh_exec': {
            try { if (!remote.isConnected()) return 'Erro: nenhuma conexão SSH ativa'; const r = await remote.execRemote(args.comando || ''); return r || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'ssh_status': {
            try { return JSON.stringify(remote.getStatus()); } catch (e) { return 'Desconectado'; }
        }
        case 'docker_run': {
            const fullCmd = `docker ${String(args.comando || 'ps').trim()}`;
            const validationError = validateAgentCommand(fullCmd);
            if (validationError) return `Erro: ${validationError}`;
            try { const r = await runner.runCommand({ command: fullCmd, cwd: PROJECT_ROOT, timeoutMs: 30000 }); return (r.stdout || r.output || '').slice(0, 3000).trim() || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'undo': {
            try { const r = await undoLastChange(); return r || 'Nada para desfazer'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'redo': {
            try { const r = await redoLastChange(); return r || 'Nada para refazer'; } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'search_replace': {
            try {
                const base = resolveSafePath(args.caminho || '');
                const pattern = stripBOM(args.padrao || '');
                const replacement = args.substituto || '';
                if (!pattern) return 'Erro: informe o padrão';
                const files = base && fs.existsSync(base) ? (fs.statSync(base).isDirectory() ? getAllFiles(base, { n: 0 }).slice(0, 50) : [base]) : getAllFiles(PROJECT_ROOT, { n: 0 }).slice(0, 50);
                let count = 0;
                for (const f of files) {
                    if (!fs.statSync(f).isFile()) continue;
                    const content = stripBOM(fs.readFileSync(f, 'utf-8'));
                    const before = content;
                    const { content: newContent, matched } = replaceInContent(content, pattern, replacement);
                    if (matched && newContent !== before) {
                        backupFromContent(path.relative(PROJECT_ROOT, f), before);
                        fs.writeFileSync(f, newContent, 'utf-8');
                        count++;
                    }
                }
                return count > 0 ? `${count} arquivo(s) alterado(s)` : 'Nenhum arquivo alterado (padrão não encontrado em nenhum arquivo). Tente usar write_file para reescrever o arquivo inteiro.';
            } catch (e) { return `Erro: ${e.message}`; }
        }
        case 'task': {
            const descricao = args.descricao || args.task || '';
            if (!descricao) return 'Erro: descrição da subtarefa vazia';
            const subProvider = _currentAgentProvider || 'gemini';
            const subSignal = _currentAgentSignal || null;
            const subPrompt = `Você é um subagente de investigação. Execute APENAS esta subtarefa e retorne um resumo conciso do resultado.\n\nSUBTAREFA: ${descricao}\n\nUse as ferramentas de leitura (read_file, search_code, list_files, analyzer_symbols) para investigar. NÃO modifique arquivos.`;
            try {
                const summary = await runAgentLoop(subPrompt, null, subSignal, 'plan', [], subProvider);
                return summary ? `Subagente concluído: ${summary.slice(0, 2000)}` : 'Subagente concluído sem resumo';
            } catch (e) {
                return `Erro no subagente: ${e.message}`;
            }
        }
        case 'question': {
            const pergunta = args.pergunta || args.question || '';
            if (!pergunta) return 'Erro: pergunta vazia';
            const response = await requestUserInteraction('question', { pergunta }, _currentAgentSignal || null);
            if (!response || !response.resposta) return 'Usuário não respondeu.';
            return `Resposta do usuário: ${response.resposta}`;
        }
        case 'todo': {
            const tarefas = Array.isArray(args.tarefas) ? args.tarefas : [];
            _agentTodos = tarefas.map((t, i) => {
                const titulo = typeof t === 'string' ? t : (t.titulo || t.title || 'Tarefa ' + (i + 1));
                const status = typeof t === 'string' ? 'pending' : (t.status || 'pending');
                return { titulo, status };
            });
            const list = _agentTodos.map((t, i) => `${i + 1}. [${t.status}] ${t.titulo}`).join('\n');
            if (agentStreamCallback) agentStreamCallback('todo', JSON.stringify(_agentTodos));
            return `Plano de tarefas atualizado:\n${list || '(vazio)'}`;
        }
        default: {
            if (name === 'browser_content') {
                try { return await executeBrowserTool(name, {}); } catch (e) { return `Erro Browser: ${e.message}`; }
            }
            if (name.startsWith('mcp_')) {
                try { return await mcpManager.executeTool(name, args); }
                catch (e) { return `Erro MCP: ${e.message}`; }
            }
            if (name.startsWith('browser_')) {
                try { return await executeBrowserTool(name, args); }
                catch (e) { return `Erro Browser: ${e.message}`; }
            }
            return 'Erro: ferramenta desconhecida';
        }
    }
}

function getAllToolDeclarations() {
    const builtin = Object.values(TOOL_SCHEMAS);
    const mcpTools = mcpManager.getAllTools().map(t => ({
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.parameters || {}, required: Object.keys(t.parameters || {}) }
    }));
    return [...builtin, ...mcpTools];
}

function getAgentToolsForMode(mode) {
    const allTools = getAllToolDeclarations();
    if (mode === 'review' || mode === 'plan') {
        return allTools.filter(t => !['write_file', 'delete_file', 'search_replace', 'file_rename', 'exec_command', 'git_commit', 'git_push', 'git_publish', 'docker_run', 'ssh_exec', 'undo', 'redo', 'snapshot_restore', 'browser_navigate', 'browser_click', 'browser_type', 'task'].includes(t.name));
    }
    return allTools;
}

function getQualityRules() {
    const projectRules = loadProjectRules();
    const langRules = getLanguageQualityRules();
    return `⚠️ REGRAS DE QUALIDADE (siga rigorosamente):
- KISS: código mais simples que resolve o problema
- DRY: nunca duplique lógica — extraia funções
- Funções pequenas (máx 20 linhas), responsabilidade única
- Nomes claros: revelar intenção (calcularTotal, nao calc)
- Trate erros: capture exceções, propague com contexto
- Valide entrada: Number.isNaN, null/undefined checks
- Após write_file, use read_file para verificar
- Use search_code para padrões existentes antes de criar novos
- Prefira const, arrow functions, template literals
${langRules}
${projectRules ? '\nREGRAS DO PROJETO:\n' + projectRules : ''}`;
}

function getLanguageQualityRules() {
    try {
        const idx = analyzer.indexProject(PROJECT_ROOT);
        const files = Object.keys(idx.files || {});
        const exts = {};
        for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (ext) exts[ext] = (exts[ext] || 0) + 1;
        }
        const top = Object.entries(exts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
        let rules = '\nCHECKLIST DE SEGURANÇA POR LINGUAGEM:';

        if (top.some(e => ['.js', '.ts', '.jsx', '.tsx'].includes(e))) {
            rules += '\n[JavaScript/TypeScript] XSS (innerHTML, dangerouslySetInnerHTML), eval(), secrets no código, SQL injection em queries concatenadas, validação de input, tratamento de Promises, race conditions.';
        }
        if (top.some(e => ['.py'].includes(e))) {
            rules += '\n[Python] SQL injection (string formatting em queries), secrets expostos, eval/exec, pickle.load, path traversal, subprocess shell=True, dependências inseguras.';
        }
        if (top.some(e => ['.go'].includes(e))) {
            rules += '\n[Go] SQL injection, goroutine leaks, defer em loops, panic sem recover, race conditions, secrets hardcoded, validação de input.';
        }
        if (top.some(e => ['.rs'].includes(e))) {
            rules += '\n[Rust] unsafe blocks, unwrap() em produção, panic propagation, secrets hardcoded, SQL injection com raw queries.';
        }
        if (top.some(e => ['.php'].includes(e))) {
            rules += '\n[PHP] SQL injection, XSS (echo sem escape), eval(), file inclusion, secrets em .env exposto, CSRF, password hashing fraco.';
        }
        if (top.some(e => ['.rb'].includes(e))) {
            rules += '\n[Ruby] SQL injection em ActiveRecord raw, eval(), mass assignment, secrets no código, CSRF, regex DoS.';
        }
        if (top.some(e => ['.java', '.kt'].includes(e))) {
            rules += '\n[Java/Kotlin] SQL injection em JDBC, secrets hardcoded, XXE em XML parsers, serialization insegura, path traversal, NPE sem tratamento.';
        }
        if (top.some(e => ['.html'].includes(e))) {
            rules += '\n[HTML/CSS] XSS via innerHTML, atributos unsafe-inline, CSS injection, target="_blank" sem noopener.';
        }
        if (top.some(e => ['.css', '.scss', '.less'].includes(e))) {
            rules += '\n[CSS] CSS injection via user input, z-index stacking, overflow hidden ausente, responsividade quebrada (< 320px).';
        }
        rules += '\n[GERAL] Nunca hardcode secrets, tokens, API keys ou senhas. Use variáveis de ambiente.';
        return rules;
    } catch (e) {
        return '';
    }
}

const AGENT_BEHAVIOR_RULES = `
REGRAS DE EXECUÇÃO:
- AÇÃO DIRETA: aja como o opencode. Após 1-2 leituras para entender, EDITE o arquivo (search_replace para mudanças pontuais, write_file para novos/reescritas). Não fique lendo arquivo após arquivo sem modificar nada.
- AUTO-CORREÇÃO: após cada write_file ou search_replace, SE o resultado do validador mostrar ERROS REAIS (não avisos de escopo como "pode não estar definido neste escopo", que são falsos positivos), corrija-os NO MESMO ARQUIVO antes de seguir para outro. Máximo ~3 tentativas por arquivo.
- VERIFICAÇÃO FINAL: antes de concluir, releia os arquivos alterados (read_file), valide a sintaxe e, se houver testes no projeto, rode test_run. Corrija erros reais antes de finalizar.
- EDIÇÃO CIRÚRGICA: prefira search_replace para alterações pontuais em arquivos existentes. Use write_file apenas para arquivos novos ou reescritas completas necessárias.
- NÃO EXECUTE SERVIDORES/NPM INSTALL/DEPENDÊNCIAS: evite comandos que não terminam (ex.: node app.js, npm run dev, servidores). Use exec_command apenas para validação rápida (testes, lint, sintaxe) e sempre com fim definido.
- CONVERGÊNCIA: você SÓ deve finalizar sem modificar nada se a tarefa for uma pergunta ou se concluir com certeza que nenhuma mudança é necessária. Para tarefas de correção/melhoria, você DEVE aplicar a alteração.
- AMBIGUIDADE: se o pedido for genuinamente ambíguo e houver 2+ direções válidas, use a ferramenta question para perguntar ao usuário ANTES de implementar.${LANGUAGE_RULE}`;

function getAgentSystemPrompt(task) {
    const fileTree = getFileTree('', '', { n: 0 }).slice(0, 1500);
    let imageNote = '';
    if (_pendingImages && _pendingImages.length) {
        imageNote = `\n🖼️ ${_pendingImages.length} imagem(ns) anexada(s). Analise para entender o estado da UI.`;
    }
    return `Você é um agente de desenvolvimento no Aedificator Codex IDE. Seja direto, conciso e acionável.

${LANGUAGE_RULE}

${getQualityRules()}

DIRETÓRIO: ${PROJECT_ROOT}
${fileTree ? 'ESTRUTURA:\n' + fileTree : ''}${imageNote}

TAREFA: ${task}

COMPORTAMENTO:
- TRABALHE INCREMENTALMENTE: 1-2 arquivos por vez, valide, depois prossiga.
- Use search_code para evitar duplicar funções já existentes.
- Após concluir, responda em 1-2 linhas com o que foi feito.
${AGENT_BEHAVIOR_RULES}`;
}

function getDeepSeekAgentPrompt(task) {
    const fileTree = getFileTree('', '', { n: 0 }).slice(0, 1200);
    let imageNote = '';
    if (_pendingImages && _pendingImages.length) {
        imageNote = `\n⚠️ O usuário anexou ${_pendingImages.length} imagem(ns). O DeepSeek NÃO suporta visão — use apenas as instruções textuais.`;
    }
    return `Você é um agente de desenvolvimento no Aedificator Codex IDE. Seja direto e conciso, como o opencode.

${LANGUAGE_RULE}

1. DIRETÓRIO: ${PROJECT_ROOT}
${fileTree ? 'ESTRUTURA:\n' + fileTree : '(pasta vazia)'}

2. TAREFA: ${task}

3. COMPORTAMENTO (IMPORTANTE — siga rigorosamente):
- Aja como o opencode: leia o arquivo relevante UMA vez, identifique o problema, e EDITE imediatamente com search_replace (edição cirúrgica) ou write_file (arquivo novo/reescrita).
- NÃO fique lendo vários arquivos antes de agir. Máximo 2-3 leituras totais.
- NÃO use exec_command para ls/dir/cat/type/npm/npx/node -e. Use read_file/search_code.
- Depois de editar, releia o arquivo (read_file) para confirmar que a mudança ficou correta.
- 1 arquivo por vez. Escreva, veja os erros, corrija. Depois faça o próximo.
- Ao finalizar, responda em 1-2 linhas o que foi alterado.
${AGENT_BEHAVIOR_RULES}`;
}

// =============================================
//  AGENT LOOP UNIFICADO — adapter de provider + ferramentas
// =============================================

// Formato canônico de mensagem:
//   { role: 'system' | 'user' | 'assistant' | 'tool', content, tool_calls?, tool_call_id?, name? }

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
            contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: String(m.content).slice(0, toolResultMax()) } } }] });
        } else {
            const parts = [];
            if (systemText && !systemApplied) { parts.push({ text: systemText }); systemApplied = true; }
            if (firstUser && _pendingImages && _pendingImages.length) {
                for (const img of _pendingImages) {
                    if (img.dataUrl) {
                        const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)/);
                        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
                    }
                }
                clearPendingImages();
            }
            firstUser = false;
            parts.push({ text: m.content });
            contents.push({ role: 'user', parts });
        }
    }
    return contents;
}

async function fetchGeminiStreamRaw(url, body, onChunk, signal) {
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    }, 120000, signal);
    if (!response.ok) {
        const err = await response.text();
        const hint = getProviderErrorHint(response.status, err, 'gemini');
        const msg = hint || `Gemini HTTP ${response.status}: ${err.slice(0, 300)}`;
        logError('gemini-api', msg, err.slice(0, 500));
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
    const geminiKey = config.gemini.apiKey;
    if (!geminiKey) throw new Error('Chave Gemini não configurada');
    const model = _currentTaskModel || config.gemini.model || 'gemini-2.5-flash';
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${geminiKey}`);
    const toolDeclarations = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    const body = JSON.stringify({
        contents: geminiContentsFromCanonical(messages),
        tools: [{ functionDeclarations: toolDeclarations }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
    });
    const raw = await fetchGeminiStreamRaw(url, body, null, signal);
    if (raw.usage) {
        const cacheHit = raw.usage.cachedContentTokenCount || 0;
        trackTokens('gemini', raw.usage.promptTokenCount || 0, raw.usage.candidatesTokenCount || 0, cacheHit > 0, model, cacheHit);
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
            out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content).slice(0, toolResultMax()) });
        } else {
            if (firstUser && allowImages) {
                firstUser = false;
                const images = getImagePartsForOpenAI();
                if (images) {
                    out.push({ role: 'user', content: [...images, { type: 'text', text: m.content }] });
                    clearPendingImages();
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
    const apiKey = provider === 'deepseek' ? config.deepseek.apiKey : config.openai.apiKey;
    if (!apiKey) throw new Error(`Chave ${provider} não configurada`);
    const baseUrl = provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';
    const model = provider === 'deepseek' ? (_currentTaskModel || config.deepseek.model || 'deepseek-v4-flash') : (_currentTaskModel || config.openai.model || 'gpt-4o');

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
        response = await retryWithBackoff(
            () => {
                // Cria o timeout FRESCO por tentativa (o sinal externo é imutável).
                const attemptSignal = baseSignal && typeof baseSignal.aborted === 'boolean' && typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([baseSignal, AbortSignal.timeout(API_TIMEOUT_MS)])
                    : baseSignal;
                return fetch(baseUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: safeJsonStringify(body),
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
        const hint = getProviderErrorHint(0, fetchErr.message, provider);
        const msg = hint ? hint : `❌ ${provider} indisponível: ${fetchErr.message.slice(0, 150)}`;
        if (onChunk) onChunk('Sistema', msg + '\n');
        throw new Error(msg);
    }
    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const hint = getProviderErrorHint(response.status, errorBody, provider);
        throw new Error(hint || `${provider} HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    const data = await response.json();
    if (data.usage) {
const model = provider === 'deepseek' ? (_currentTaskModel || config.deepseek.model || 'deepseek-v4-flash') : (_currentTaskModel || config.openai.model || 'gpt-4o');
        const cacheHit = provider === 'deepseek'
            ? (data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0)
            : 0;
        trackTokens(provider, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cacheHit > 0, model, cacheHit);
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) return { text: 'Sem resposta', toolCalls: [] };
    const toolCalls = (msg.tool_calls || []).map(tc => {
        let args = {};
        try {
            args = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
            logError('tool-args', `JSON inválido nos argumentos de ${tc.function.name}`, e.message.slice(0, 200));
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
            out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content).slice(0, toolResultMax()) }] });
        } else {
            let text = m.content;
            if (systemText && !systemApplied) { text = systemText + '\n\n' + text; systemApplied = true; }
            if (firstUser) {
                firstUser = false;
                const images = getImagePartsForClaude();
                if (images && images.length) {
                    out.push({ role: 'user', content: [...images, { type: 'text', text }] });
                    clearPendingImages();
                    continue;
                }
            }
            out.push({ role: 'user', content: text });
        }
    }
    return out;
}

async function callAgentClaude(messages, tools, signal) {
    const apiKey = config.claude.apiKey;
    if (!apiKey) throw new Error('Chave Claude não configurada');
    const model = _currentTaskModel || config.claude.model || 'claude-sonnet-5';
    const toolDefs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: safeJsonStringify({ model, max_tokens: 4096, messages: claudeMessagesFromCanonical(messages), tools: toolDefs }),
        signal
    });
    if (!response.ok) throw new Error(`Claude HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

    const data = await response.json();
    if (data.usage) {
        const cacheHit = data.usage.cache_read_input_tokens || 0;
        trackTokens('claude', data.usage.input_tokens || 0, data.usage.output_tokens || 0, cacheHit > 0, model, cacheHit);
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
    if (config.gemini?.apiKey) providers.push('gemini');
    if (config.deepseek?.apiKey) providers.push('deepseek');
    if (config.openai?.apiKey) providers.push('openai');
    if (config.claude?.apiKey) providers.push('claude');
    return providers;
}

function isNetworkError(err) {
    const m = String((err && err.message) || '').toLowerCase();
    return /fetch failed|enetunreach|econnrefused|econnreset|etimedout|timeout|network|socket hang up|failed to fetch|temporary failure/i.test(m);
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
                _currentAgentProvider = candidate;
            }
            return result;
        } catch (err) {
            lastErr = err;
            const networkErr = isNetworkError(err);
            const isLast = candidate === candidates[candidates.length - 1];
            if (isLast) break;
            if (onChunk) onChunk('Sistema', `⚠️ ${candidate} falhou (${err.message.slice(0, 100)}). Tentando ${candidates[candidates.length - 1]}...\n`);
            if (!networkErr) break;
        }
    }
    throw lastErr || new Error('Todos os providers falharam');
}

// =============================================
//  PERMISSÕES POR TOOL (allow/deny/ask)
// =============================================
function summarizeToolArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
        if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '...';
        else out[k] = v;
    }
    return out;
}

function requestUserInteraction(kind, payload, signal) {
    return new Promise((resolve) => {
        const id = 'int_' + (++_interactionSeq) + '_' + crypto.randomBytes(4).toString('hex');
        let settled = false;
        let timer = null;
        const cleanup = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            if (timer) clearTimeout(timer);
            pendingInteractions.delete(id);
        };
        const onAbort = () => { if (!settled) { settled = true; cleanup(); resolve(null); } };
        timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve(null); } }, 120000);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        pendingInteractions.set(id, {
            kind,
            resolve: (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } }
        });
        if (agentStreamCallback) {
            agentStreamCallback('interaction', JSON.stringify({ id, kind, ...payload }));
        } else if (!settled) {
            settled = true;
            cleanup();
            resolve(null);
        }
    });
}

function isAskTool(name) {
    return Array.isArray(config.toolPermissions.ask) && config.toolPermissions.ask.includes(name);
}

function setToolGrant(name, value) {
    if (!config.toolPermissions.grants) config.toolPermissions.grants = {};
    config.toolPermissions.grants[name] = value;
    try { saveConfigToFile(); } catch (e) { logError('permissions-save', 'Erro ao salvar permissões', e.message); }
}

async function checkToolPermission(name, args, signal) {
    const grants = config.toolPermissions.grants || {};
    if (grants[name] === 'allow') return 'allow';
    if (grants[name] === 'deny') return 'deny';
    if (!isAskTool(name)) return 'allow';
    const response = await requestUserInteraction('permission', {
        tool: name,
        label: buildToolLabel(name, args),
        args: summarizeToolArgs(args)
    }, signal);
    if (!response || response.allow !== true) {
        if (response && response.always) setToolGrant(name, 'deny');
        return 'deny';
    }
    if (response.always) setToolGrant(name, 'allow');
    return 'allow';
}

// =============================================
//  COMPACTAÇÃO DE CONTEXTO
// =============================================
const COMPACT_THRESHOLD = 40;

async function maybeCompactMessages(provider, messages, signal) {
    if (messages.length <= COMPACT_THRESHOLD) return;
    const systemMsg = messages.find(m => m.role === 'system');
    let keepFrom = Math.max(systemMsg ? 1 : 0, messages.length - 12);
    // A API OpenAI/DeepSeek exige que "tool" siga um "assistant" com tool_calls.
    // Se o corte cair no meio de uma sequência de tool results, a mensagem órfã
    // geraria HTTP 400. Avança o corte até começar em um "assistant".
    while (keepFrom < messages.length && messages[keepFrom].role === 'tool') keepFrom++;
    const older = messages.slice(systemMsg ? 1 : 0, keepFrom);
    const recent = messages.slice(keepFrom);

    let summary = '';
    try {
        const convText = older.map(m => {
            if (m.role === 'assistant') return `Assistente: ${(m.content || '').slice(0, 300)}`;
            if (m.role === 'tool') return `[tool ${m.name}: ${(m.content || '').slice(0, 150)}]`;
            return `Usuário: ${(m.content || '').slice(0, 300)}`;
        }).join('\n');
        summary = await callAI(provider, `Resuma de forma concisa o progresso da conversa abaixo (arquivos alterados, decisões, próximos passos). Máximo 300 palavras.\n\n${convText.slice(0, toolResultMax())}`, null, signal);
    } catch (e) {
        summary = '';
    }

    const rebuilt = [];
    if (systemMsg) rebuilt.push(systemMsg);
    rebuilt.push({ role: 'user', content: summary ? `RESUMO DA CONVERSA ANTERIOR (compactado automaticamente):\n${summary}` : 'Conversa anterior omitida para economizar contexto.' });
    rebuilt.push(...recent);
    messages.length = 0;
    messages.push(...rebuilt);
    if (agentStreamCallback) agentStreamCallback('Sistema', '🗜️ Contexto compactado para economizar tokens.\n');
}

// =============================================
//  AGENT LOOP — UNIFICADO
function hasRealWriteErrors(resultStr) {
    const s = String(resultStr || '');
    const m = s.match(/⚠️\s*(\d+)\s*erro\(s\)/);
    if (!m || parseInt(m[1], 10) === 0) return false;
    const errorBlock = s.split('💡')[0];
    const scopeFalse = (errorBlock.match(/pode não estar definido neste escopo/g) || []).length;
    return scopeFalse < parseInt(m[1], 10);
}

// =============================================
async function runAgentLoop(task, onChunk, signal, mode, history, provider) {
    const systemPrompt = provider === 'deepseek' ? getDeepSeekAgentPrompt(task) : getAgentSystemPrompt(task);
    const tools = getAgentToolsForMode(mode);
    const maxIterations = 20;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }];
    const prevProvider = _currentAgentProvider;
    const prevSignal = _currentAgentSignal;
    const prevTodos = _agentTodos;
    _currentAgentProvider = provider;
    _currentAgentSignal = signal;
    _agentTodos = [];

    const loopStartSnapshot = snapshotProjectFiles();
    const activeProvider = { value: provider };
    let noActionCount = 0;

    try {
        let iteration = 0;
        while (iteration < maxIterations) {
            if (signal && signal.aborted) {
                const err = new Error('Tarefa cancelada');
                err.name = 'AbortError';
                throw err;
            }
            iteration++;
            if (iteration >= maxIterations - 1 && onChunk) onChunk('Sistema', `⚠️ Iteração ${iteration}/${maxIterations} — finalize a tarefa.\n`);

            const thoughtStart = Date.now();
            const { text, toolCalls } = await callAgentProviderWithFallback(activeProvider.value, messages, tools, signal, onChunk, activeProvider);
            const elapsed = ((Date.now() - thoughtStart) / 1000).toFixed(1);

            if (text && onChunk) onChunk('Assistente', text);
            if (toolCalls.length === 0) {
                // O agente devolveu texto sem executar NENHUMA ferramenta. Isso é
                // legítimo para perguntas/consultas, mas se a tarefa pede uma
                // implementação e o texto parece indecisão/plano ("vou", "posso",
                // "preciso", "poderia", "sugiro"...), NÃO desistimos — forçamos a
                // execução por até 2 tentativas antes de concluir.
                const looksLikeActionTask = /(faça|crie|implemente|adicione|corrija|melhore|modifique|ajuste|refatore|escreva|altere|cria|implementar|melhorar|corrigir|adicionar)/i.test(task);
                const looksHesitant = /(^|\s)(vou|posso|poderia|preciso|devo|sugiro|planejo|vamos|pretendo|poderíamos|poderia|analisar|pensar|estudar)\b/i.test(text || '') || /(\?\s*$)|(escolha|prefere|qual opção|sugest[ãa]o)/i.test(text || '');
                if (looksLikeActionTask && looksHesitant && noActionCount < 2) {
                    noActionCount++;
                    messages.push({
                        role: 'user',
                        content: 'NÃO responda com plano ou pergunta. A tarefa é de IMPLEMENTAÇÃO: use as ferramentas write_file / search_replace / exec_command AGORA para fazer as alterações no código. Se precisar explorar, faça NO MÁXIMO 1 leitura e depois altere.'
                    });
                    continue;
                }
                return text || 'Agente concluído';
            }
            if (onChunk) onChunk('Sistema', `+ Thought: ${elapsed}s\n`);

            messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });

            // Auto-correção NÃO pode ser inserida entre tool calls: a API OpenAI/DeepSeek
            // exige que mensagens "tool" sigam imediatamente um "assistant" com tool_calls.
            // A instrução é acumulada e enviada como "user" DEPOIS de todos os tool results.
            let autoCorrectPending = false;

            for (const tc of toolCalls) {
                if (onChunk) onChunk('Sistema', `🔧 ${tc.name}(${Object.values(tc.args).join(', ').slice(0, 60)})\n`);
                const decision = await checkToolPermission(tc.name, tc.args, signal);
                let result;
                let toolError = false;
                let resultStr = '';
                if (decision === 'deny') {
                    result = 'Permissão negada pelo usuário.';
                    toolError = true;
                    if (onChunk) onChunk('Sistema', '  ⛔ negado pelo usuário\n');
                } else {
                    if (onChunk) onChunk('activity', JSON.stringify({
                        ev: 'tool_start', id: tc.id, tool: tc.name,
                        label: buildToolLabel(tc.name, tc.args), icon: getToolIcon(tc.name),
                        file: tc.args.filePath || tc.args.path || tc.args.file || tc.args.caminho || '',
                        code: (tc.name === 'write_file' || tc.name === 'search_replace')
                            ? String(tc.args.content || tc.args.code || tc.args.newContent || '').slice(0, 4000)
                            : ''
                    }));
                    const toolStart = Date.now();
                    try {
                        result = await executeAgentTool(tc.name, tc.args);
                    } catch (toolErr) {
                        result = `Erro: ${toolErr.message}`;
                        toolError = true;
                        if (onChunk) onChunk('Sistema', `  ⚠️ falhou: ${toolErr.message.slice(0, 80)}\n`);
                    }
                    const toolElapsed = ((Date.now() - toolStart) / 1000).toFixed(1);
                    resultStr = String(result);
                    if (!toolError) {
                        const preview = resultStr.length > 120 ? resultStr.slice(0, 120).replace(/\n/g, ' ') + '...' : resultStr.replace(/\n/g, ' ');
                        if (tc.name === 'read_file' || tc.name === 'list_files' || tc.name === 'search_code' || tc.name === 'exec_command') {
                            if (onChunk) onChunk('Sistema', `  → ${resultStr.length} bytes · ${toolElapsed}s\n`);
                        } else if (onChunk && resultStr.length) {
                            onChunk('Sistema', `  → ${preview} · ${toolElapsed}s\n`);
                        }
                    }
                    if (onChunk) onChunk('activity', JSON.stringify({ ev: 'tool_end', id: tc.id, isError: toolError, error: toolError ? (resultStr || 'Erro desconhecido').slice(0, 120) : undefined }));
                }
                messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: truncateToolResult(tc.name, result) });

                const toolResultStr = String(result);
                if ((tc.name === 'write_file' || tc.name === 'search_replace') && !toolError && hasRealWriteErrors(toolResultStr)) {
                    autoCorrectPending = true;
                    if (onChunk) onChunk('Sistema', '⚠️ Auto-correção: há erros reais no arquivo. Corrija antes de prosseguir.\n');
                }
            }

            if (autoCorrectPending) {
                messages.push({
                    role: 'user',
                    content: '⚠️ [Auto-correção] A validação do arquivo acima acusou erros REAIS (não avisos de escopo). Corrija-os AGORA no mesmo arquivo antes de prosseguir. IGNORE "pode não estar definido neste escopo" — são falsos positivos.'
                });
            }

            await maybeCompactMessages(provider, messages, signal);
        }
        const loopChanges = diffSnapshots(loopStartSnapshot, snapshotProjectFiles());
        if (loopChanges.length > 0) {
            const fileList = loopChanges.slice(0, 8).map(c => `${c.file} (${c.action})`).join(', ');
            return `Limite de iterações atingido — ${loopChanges.length} arquivo(s) alterado(s): ${fileList}${loopChanges.length > 8 ? '...' : ''}`;
        }
        return 'Limite de iterações atingido sem alterações de arquivos — o pedido pode ser amplo demais; separe em tarefas menores ou use o modo Direto.';
    } finally {
        _currentAgentProvider = prevProvider;
        _currentAgentSignal = prevSignal;
        _agentTodos = prevTodos;
    }
}

function runQuickTest(filePath) {
    try {
        const ext = path.extname(filePath).toLowerCase();
        const dir = path.dirname(path.join(PROJECT_ROOT, filePath));
        const name = path.basename(filePath, ext);
        let cmd = null;
        let timeout = 15000;

        if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
            if (fs.existsSync(path.join(PROJECT_ROOT, 'jest.config.js')) || fs.existsSync(path.join(PROJECT_ROOT, 'jest.config.ts')) || fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))) {
                const testFile = findTestFile(filePath, '.test.', '.spec.');
                if (testFile && fs.existsSync(path.join(PROJECT_ROOT, testFile))) {
                    cmd = `npx jest "${testFile}" --no-coverage --forceExit 2>&1`;
                } else {
                    cmd = `npx jest --no-coverage --forceExit --testPathPattern="${name}" 2>&1`;
                }
            }
        } else if (ext === '.py') {
            const testFile = findTestFile(filePath, 'test_', '_test');
            if (testFile && fs.existsSync(path.join(PROJECT_ROOT, testFile))) {
                cmd = `python -m pytest "${testFile}" -x --tb=short 2>&1`;
            }
            timeout = 20000;
        } else if (ext === '.go') {
            const pkgDir = path.dirname(filePath);
            cmd = `go test "./${pkgDir}" -count=1 -timeout 10s 2>&1`;
            timeout = 20000;
        } else if (ext === '.rs') {
            cmd = `cargo test --quiet 2>&1`;
            timeout = 60000;
        }

        if (!cmd) return null;
        const result = require('child_process').execSync(cmd, { cwd: PROJECT_ROOT, timeout, encoding: 'utf-8', maxBuffer: 1024 * 512 });
        const lines = result.split('\n');
        const summary = lines.filter(l => /pass|fail|error|PASS|FAIL|ERROR|tests?|ok/i.test(l)).slice(-5).join('\n').trim();
        if (summary) return `🧪 Testes: ${summary.slice(0, 500)}`;
        return `🧪 Testes executados (${lines.length} linhas de output)`;
    } catch (e) {
        const out = (e.stdout || e.stderr || e.message || '').slice(0, 500);
        if (out.includes('FAIL') || out.includes('fail') || out.includes('Error') || out.includes('error')) {
            return `🧪 ⚠️ Falha nos testes: ${out.slice(0, 400)}`;
        }
        return null;
    }
}

function findTestFile(sourcePath, prefix, suffix) {
    const dir = path.dirname(sourcePath);
    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    const candidates = [
        path.join(dir, prefix + base + suffix + ext),
        path.join(dir, '__tests__', prefix + base + suffix + ext),
        path.join(dir.replace('src', 'test').replace('src', 'tests'), prefix + base + suffix + ext),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(PROJECT_ROOT, c))) return c;
    }
    return null;
}

function getTestFilePath(sourcePath) {
    const dir = path.dirname(sourcePath);
    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    if (['.js', '.jsx'].includes(ext)) return path.join(dir, base + '.test' + ext);
    if (['.ts', '.tsx'].includes(ext)) return path.join(dir, base + '.test' + ext);
    if (ext === '.py') {
        const d = path.dirname(sourcePath); const b = path.basename(sourcePath);
        return path.join(d, 'test_' + b);
    }
    if (ext === '.go') return path.join(dir, base + '_test' + ext);
    if (ext === '.rs') return sourcePath.replace('/src/', '/tests/').replace('.rs', '_test.rs');
    return path.join(dir, base + '.test' + ext);
}

function buildTestPrompt(filePath, content, ext) {
    const langMap = { '.js': 'JavaScript (Jest)', '.jsx': 'JavaScript/React (Jest)', '.ts': 'TypeScript (Jest)', '.tsx': 'TypeScript/React (Jest)', '.py': 'Python (pytest)', '.go': 'Go (testing)', '.rs': 'Rust (#[test])' };
    const lang = langMap[ext] || 'JavaScript (Jest)';
    return `Gere testes unitários para o seguinte arquivo ${lang}:

ARQUIVO: ${filePath}

CONTEÚDO:
${content.slice(0, toolResultMax())}

REGRAS:
- Cubra TODAS as funções exportadas
- Teste casos de sucesso, erro e borda
- Use mocks para dependências externas (APIs, bancos)
- Use o framework padrão da linguagem
- Retorne APENAS o código do arquivo de teste, completo e pronto para salvar
- Sem explicações, sem markdown, apenas código`;
}

async function runAgentAndCapture(ws, task, onChunk, streamController, history, provider) {
    const beforeSnap = snapshotProjectFiles();
    const beforeContents = snapshotProjectContents();
    const summary = await runAgentLoop(task, onChunk, streamController.signal, 'agent', history, provider);
    const changes = diffSnapshots(beforeSnap, snapshotProjectFiles());
    let reviewMsg = '';
    for (const change of changes) {
        if (change.action === 'modificar' || change.action === 'deletar') {
            const orig = beforeContents.get(change.file);
            if (orig !== undefined) backupFromContent(change.file, orig);
        }
        // Anexa o conteúdo antes/depois para o frontend montar o diff inline.
        if (change.action === 'modificar') {
            change.before = beforeContents.get(change.file) || '';
            change.after = readProjectFileContent(change.file);
        } else if (change.action === 'criar') {
            change.before = '';
            change.after = readProjectFileContent(change.file);
        } else if (change.action === 'deletar') {
            change.before = beforeContents.get(change.file) || '';
            change.after = '';
        }
        if (onChunk) onChunk('file-status', JSON.stringify([change]));
        const icon = change.action === 'criar' ? '🆕' : change.action === 'deletar' ? '🗑️' : '✏️';
        reviewMsg += `${icon} ${change.file}\n`;
    }
    if (reviewMsg && onChunk) {
        onChunk('Sistema', `📋 REVISÃO — ${changes.length} arquivo(s) alterado(s):\n${reviewMsg}🔍 Executando validação...\n`);
    }
    ws.send(JSON.stringify({ type: 'refresh' }));

    const modifiedFiles = changes.filter(c => c.action !== 'deletar').map(c => c.file);

    let testSummary = '';
    for (const file of modifiedFiles.slice(0, 10)) {
        const ext = path.extname(file).toLowerCase();
        if (!['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs'].includes(ext)) continue;
        if (findTestFile(file, 'test_', '_test') || findTestFile(file, '.test.', '.spec.')) continue;
        const tp = getTestFilePath(file);
        if (fs.existsSync(path.join(PROJECT_ROOT, tp))) continue;
        try {
            const full = resolveSafePath(file);
            if (!full || !fs.existsSync(full)) continue;
            const content = fs.readFileSync(full, 'utf-8');
            if (content.length < 50) continue;
            const tPrompt = buildTestPrompt(file, content, ext);
            const tCode = await callAI('gemini', tPrompt, null, null);
            const clean = tCode.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
            if (clean.length >= 20) {
                const tFull = path.join(PROJECT_ROOT, tp);
                const tDir = path.dirname(tFull);
                if (!fs.existsSync(tDir)) fs.mkdirSync(tDir, { recursive: true });
                fs.writeFileSync(tFull, clean, 'utf-8');
                if (onChunk) onChunk('Sistema', `🧪 Teste gerado: ${tp}\n`);
                testSummary += ` ${tp}`;
            }
        } catch (e) {}
    }
    if (testSummary && onChunk) onChunk('Sistema', `🧪 Testes automáticos gerados:${testSummary}\n`);

    if (modifiedFiles.length > 0) {
        try {
            const allErrors = [];
            for (const file of modifiedFiles.slice(0, 20)) {
                try {
                    const full = resolveSafePath(file);
                    if (full && fs.existsSync(full)) {
                        const content = fs.readFileSync(full, 'utf-8');
                        const validation = analyzer.validateCode(content, file, PROJECT_ROOT);
                        for (const e of validation.errors) {
                            allErrors.push({ file, line: e.line, column: e.column, message: e.message, severity: e.severity });
                        }
                    }
                } catch (e) {}
            }
            if (allErrors.length > 0) {
                ws.send(JSON.stringify({ type: 'diagnostics', errors: allErrors }));
                const errCount = allErrors.filter(e => e.severity === 'error').length;
                const warnCount = allErrors.filter(e => e.severity === 'warning').length;
                let diagSummary = summary || 'Agente concluído';
                if (errCount > 0) diagSummary += ` (${errCount} erro(s), ${warnCount} aviso(s))`;
                ws.send(JSON.stringify({ type: 'done', summary: diagSummary, command: task }));
                return;
            }
        } catch (e) {}
    }
    ws.send(JSON.stringify({ type: 'done', summary: summary || 'Agente concluído ✅', command: task }));
}

// =============================================
//  AUTO-CORREÇÃO COM IA (loop de correção)
// =============================================
async function autoFixWithAI(filePath, code, errors, onChunk, signal) {
    const errorText = errors.map(e => `Ln ${e.line}: ${e.message}`).join('\n');
    const prompt = `O seguinte código para o arquivo ${filePath} tem erros:\n\n` +
        `\`\`\`\n${code}\n\`\`\`\n\n` +
        `ERROS:\n${errorText}\n\n` +
        `Corrija APENAS os erros. Retorne SOMENTE o código completo corrigido em um bloco \`\`\`. Não adicione explicações.`;

    try {
        const response = await analyzeTask(prompt, onChunk, signal, 'code', [], 'gemini');
        const codeMatch = response.match(/```[\w]*\n([\s\S]*?)```/);
        if (codeMatch) return codeMatch[1].trim();
        if (response.trim() && !response.includes('{')) return response.trim();
    } catch (e) {}
    return code;
}

// =============================================
//  REGRAS DO PROJETO (AGENTS.md)
// =============================================
const AGENTS_FILE = '.aedificator-agents.md';

function loadProjectRules() {
    const filePath = path.join(PROJECT_ROOT, AGENTS_FILE);
    if (!fs.existsSync(filePath)) return '';
    try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch (e) { return ''; }
}

app.get('/api/project/rules', (req, res) => {
    const filePath = path.join(PROJECT_ROOT, AGENTS_FILE);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    const defaultTemplate = `# Regras do Projeto\n\n## REGRA DE OURO\n- Pode melhorar o código (refatorar, otimizar, limpar), mas TODAS as funções existentes devem CONTINUAR FUNCIONANDO.\n- Melhore a qualidade sem alterar o comportamento.\n- Se uma função recebe X e retorna Y, continue recebendo X e retornando Y — mesmo que o código interno mude.\n\n## Convenções de Código\n- Use ponto e vírgula\n- Prefira const a let\n- Use arrow functions\n\n## Arquitetura\n- Separe lógica de negócio da UI\n\n## Preferências\n- Prefira alterações mínimas e seguras\n`;
    res.json({ success: true, content: content || defaultTemplate, exists: fs.existsSync(filePath) });
});

app.post('/api/project/rules', (req, res) => {
    const filePath = path.join(PROJECT_ROOT, AGENTS_FILE);
    try {
        fs.writeFileSync(filePath, ((req.body.content || '').trim() || '') + '\n', 'utf-8');
        res.json({ success: true, path: AGENTS_FILE });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================
//  CONTEXTO INTELIGENTE (arquivos relevantes)
// =============================================
function getRelevantFileContents(message) {
    const relevant = {};
    const idx = analyzer.indexProject(PROJECT_ROOT);
    const keywords = extractKeywords(message);
    let scoredFiles = [];

    for (const [relPath, parsed] of Object.entries(idx.files)) {
        let score = 0;
        const nameLow = relPath.toLowerCase();
        for (const kw of keywords) {
            if (nameLow.includes(kw)) score += 3;
            if (parsed.exports.some(e => e.toLowerCase().includes(kw))) score += 2;
            if (parsed.functions.some(f => f.name.toLowerCase().includes(kw))) score += 2;
        }
        if (score > 0) scoredFiles.push({ path: relPath, score });
    }
    scoredFiles.sort((a, b) => b.score - a.score);
    const topFiles = scoredFiles.slice(0, 15).map(f => f.path);

    for (const ep of ['index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts', 'server.js', 'server.ts']) {
        if (idx.files[ep] && !topFiles.includes(ep)) topFiles.unshift(ep);
    }

    for (const f of topFiles.slice(0, 15)) {
        try {
            const fullPath = resolveSafePath(f);
            if (fullPath) relevant[f] = fs.readFileSync(fullPath, 'utf-8').slice(0, toolResultMax());
        } catch (e) {}
    }
    return relevant;
}

function extractKeywords(message) {
    const clean = (message || '').toLowerCase().replace(/[.,!?;:(){}[\]"'/\\]/g, ' ');
    const words = clean.split(/\s+/).filter(w => w.length > 2);
    const stopWords = new Set(['com', 'que', 'para', 'uma', 'isso', 'este', 'como', 'mas', 'por',
        'dos', 'das', 'aos', 'tem', 'sua', 'ser', 'não', 'mais', 'tudo', 'era', 'foi']);
    return [...new Set(words.filter(w => !stopWords.has(w)))].slice(0, 20);
}

function formatRelevantFiles(files) {
    if (!files || !Object.keys(files).length) return '(nenhum arquivo)';
    return Object.entries(files).map(([p, content]) =>
        `\n### ${p}\n` + '```' + `\n${content}\n` + '```\n'
    ).join('');
}

function stripAccents(s) {
    return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function classifyIntent(message) {
    const m = stripAccents((message || '').toLowerCase()).trim();
    if (/(^|\s)(o que e|o que|como funciona|explique|qual a diferenca|defina|conceito|significado|por que|porque|what is|how does|explain|what'?s the difference|define|meaning|why|quem|who|quando|when|onde|where)\b/i.test(m)) return 'question';
    if (/^(o que|como|qual|quais|por que|quando|onde|quem)\b/i.test(m)) return 'question';
    if (m.endsWith('?') && !/(crie|criar|cria|faca|fazer|implemente|implementar|corrija|corrigir|arrume|arrumar|adicione|adicionar|mude|mudar|altere|alterar|delete|deletar|remova|remover|refatore|refatorar|escreva|escrever|build|code|codigo|arquivo|file|funcao|function|componente|component|roda|rode|execute|executar|teste|testar)/i.test(m)) return 'question';
    if (m.length < 15 && m.endsWith('?')) return 'question';
    return 'task';
}

let agentStreamCallback = null;
let _pendingImages = null;
let _activeChildProcesses = [];
let _lastProjectSnapshot = null;
let _lastProjectFileList = null;
let _currentAgentProvider = 'gemini';
let _currentAgentSignal = null;
let _agentTodos = [];
let _currentTaskModel = null;
let _currentTaskComplexity = 'simple';

// Detecta tarefas grandes/abertas que exigem capacidade total do agente. As
// demais usam limites econômicos (menos iterações, contexto compactado).
const COMPLEX_TASK_RE = /refatorar|refatore|refactor|reestrutur|migr\w*|mudan[çc]a (grande|completa|total)|mudar (tudo|completo|o app|o projeto|o sistema)|todos (os arquivos|os m[oó]dulos)|v[áa]rios arquivos|arquitetur\w*|nov[oa] m[oó]dulo|nov[oa] funcionalidade completa|implementar por completo|do zero|sistema inteiro|grande refatora|reorganiz|redesenhar/i;
function isComplexTask(task) {
    return (task && task.length > 200) || COMPLEX_TASK_RE.test(task || '');
}

const pendingInteractions = new Map();
let _interactionSeq = 0;

function registerChildProcess(child) {
    _activeChildProcesses.push(child);
    child.on('close', () => {
        const idx = _activeChildProcesses.indexOf(child);
        if (idx >= 0) _activeChildProcesses.splice(idx, 1);
    });
}

// No Windows, `child.kill('SIGKILL')` mata só o shell (cmd), deixando órfãos os
// processos que ele criou (ex.: `node app.js`). `taskkill /F /T` mata a árvore
// inteira. Sem isso, comandos longos ("servidor") ficam rodando para sempre.
function killChildTree(child) {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
        try {
            require('child_process').spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
            return;
        } catch (e) {}
    }
    try { child.kill('SIGKILL'); } catch (e) {}
}

function killAllChildProcesses() {
    const procs = _activeChildProcesses.splice(0);
    for (const child of procs) {
        killChildTree(child);
    }
}

function restoreProjectSnapshot() {
    if (!_lastProjectSnapshot || !_lastProjectSnapshot.size) { _lastProjectFileList = null; return { count: 0, files: [] }; }
    const files = [];
    let count = 0;
    for (const [file, content] of _lastProjectSnapshot) {
        try {
            const absPath = path.join(PROJECT_ROOT, ...file.split('/'));
            if (content === null) {
                if (fs.existsSync(absPath)) { fs.unlinkSync(absPath); count++; files.push(file); }
            } else {
                const dir = path.dirname(absPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                if (!fs.existsSync(absPath) || fs.readFileSync(absPath, 'utf-8') !== content) {
                    fs.writeFileSync(absPath, content, 'utf-8');
                    count++;
                    files.push(file);
                }
            }
        } catch (e) {}
    }
    if (_lastProjectFileList) {
        for (const file of snapshotProjectFiles().keys()) {
            if (_lastProjectFileList.has(file)) continue;
            const absPath = path.join(PROJECT_ROOT, ...file.split('/'));
            try { if (fs.existsSync(absPath)) { fs.unlinkSync(absPath); count++; files.push(file); } } catch (e) {}
        }
    }
    _lastProjectSnapshot = null;
    _lastProjectFileList = null;
    return { count, files };
}

function setAgentStreamCallback(cb) { agentStreamCallback = cb; }
function setPendingImages(images) { _pendingImages = images; }
function clearPendingImages() { _pendingImages = null; }

function getImagePartsForOpenAI() {
    if (!_pendingImages || !_pendingImages.length) return null;
    return _pendingImages.map(img => ({
        type: 'image_url',
        image_url: { url: img.dataUrl, detail: 'auto' }
    }));
}

function getImagePartsForClaude() {
    if (!_pendingImages || !_pendingImages.length) return null;
    return _pendingImages.map(img => {
        const match = (img.dataUrl || '').match(/^data:(image\/\w+);base64,(.+)/);
        return match ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } } : null;
    }).filter(Boolean);
}

let _projectCache = null;
let _projectCacheMtime = 0;

function getProjectCache() {
    const now = Date.now();
    if (_projectCache && (now - _projectCacheMtime) < 30000) return _projectCache;
    _projectCache = buildProjectCache();
    _projectCacheMtime = now;
    return _projectCache;
}

function invalidateProjectCache() {
    _projectCache = null;
    _projectCacheMtime = 0;
    analyzer.invalidateIndex();
}

function buildProjectCache() {
    try {
        const tree = getFileTree('');
        const idx = analyzer.indexProject(PROJECT_ROOT);
        const fileNames = Object.keys(idx.files || {});
        const dirs = {};
        for (const f of fileNames) {
            const d = path.dirname(f).replace(/\\/g, '/');
            if (!dirs[d]) dirs[d] = [];
            dirs[d].push(path.basename(f));
        }
        const topDirs = Object.keys(dirs).filter(d => d !== '.').sort();
        const summary = topDirs.slice(0, 10).map(d => {
            const files = dirs[d].slice(0, 5);
            return `  ${d}/ (${dirs[d].length} arquivos): ${files.join(', ')}${dirs[d].length > 5 ? '...' : ''}`;
        }).join('\n');
        // Contexto enxuto no estilo opencode: árvore limitada + resumo por diretório.
        const treeCapped = String(tree || '').slice(0, 6000);
        return `${treeCapped || '(pasta vazia)'}\n\nRESUMO: ${fileNames.length} arquivos em ${topDirs.length} diretórios\n${summary}`;
    } catch (e) {
        return getFileTree('') || '(pasta vazia)';
    }
}

// =============================================
//  EXPLORAÇÃO PRÉVIA — navega arquivos antes de gerar o plano (PRIORIDADE 3)
// =============================================
const EXPLORATION_TOOLS = [
    TOOL_SCHEMAS.read_file,
    TOOL_SCHEMAS.list_files,
    TOOL_SCHEMAS.search_code,
    TOOL_SCHEMAS.analyzer_symbols,
];

async function runExplorationPhase(message, onChunk, signal, provider) {
    if (provider === 'opencode') return '';
    if (!['gemini', 'deepseek'].includes(provider)) return '';

    const projectCache = getProjectCache();
    const explorationPrompt = `Você é um agente de exploração. Seu trabalho é identificar APENAS os arquivos relevantes para a tarefa, SEM ler código desnecessário.

${LANGUAGE_RULE}

SOLICITAÇÃO: "${message}"

DIRETÓRIO: ${PROJECT_ROOT}

ESTRUTURA COMPLETA DO PROJETO (já indexada):
${projectCache}

MÉTODO (siga esta ordem):
1. Analise a estrutura acima e identifique os 2-4 diretórios/arquivos mais relevantes
2. Use search_code com palavras-chave da solicitação para confirmar relevância
3. Use analyzer_symbols nos arquivos candidatos (extrai funções/classes SEM ler o arquivo todo)
4. Use read_file APENAS nos arquivos que você tem certeza que vai modificar
5. Máximo 2 iterações. Retorne um resumo do que encontrou e quais arquivos modificar`;

    try {
        let explorationLog = '';
        let conversationHistory = [{ role: 'user', content: explorationPrompt }];

        for (let iteration = 0; iteration < 2; iteration++) {  
            if (signal && signal.aborted) {
                const err = new Error('Tarefa cancelada');
                err.name = 'AbortError';
                throw err;
            }

            let response;
            if (provider === 'gemini') {
                response = await callGeminiWithTools(conversationHistory, EXPLORATION_TOOLS, signal);
            } else if (provider === 'deepseek') {
                response = await callDeepSeekWithTools(conversationHistory, EXPLORATION_TOOLS, signal);
            } else {
                break;
            }

            conversationHistory.push({ role: 'assistant', content: response.text || '' });

            let hasToolCall = false;
            const toolResults = [];

            if (response.toolCalls) {
                for (const tc of response.toolCalls) {
                    if (signal && signal.aborted) {
                        const err = new Error('Tarefa cancelada');
                        err.name = 'AbortError';
                        throw err;
                    }
                    hasToolCall = true;
                    const toolName = tc.name || tc.function?.name;
                    let toolArgs = tc.args || {};
                    if (!tc.args && tc.function?.arguments) {
                        try { toolArgs = JSON.parse(tc.function.arguments); } catch (e) {}
                    }
                    if (onChunk) onChunk('Sistema', `🔍 Explorando: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})...\n`);

                    let result;
                    try {
                        result = await executeAgentTool(toolName, toolArgs);
                        if (toolName === 'read_file') {
                            explorationLog += `\n📄 ${toolArgs.caminho}:\n${result.slice(0, 2000)}\n`;
                        } else if (toolName === 'search_code') {
                            explorationLog += `\n🔎 Busca "${toolArgs.padrao}":\n${result.slice(0, 1500)}\n`;
                        } else if (toolName === 'list_files') {
                            explorationLog += `\n📂 ${toolArgs.diretorio || 'raiz'}:\n${result.slice(0, 800)}\n`;
                        } else if (toolName === 'analyzer_symbols') {
                            explorationLog += `\n🔣 Símbolos de ${toolArgs.caminho}:\n${result.slice(0, 2000)}\n`;
                        }
                    } catch (e) {
                        result = `Erro: ${e.message}`;
                    }

                    toolResults.push({ tool_call_id: tc.id, role: 'tool', content: truncateToolResult(toolName, result) });
                }
            }

            if (!hasToolCall) break;

            for (const tr of toolResults) {
                conversationHistory.push(tr);
            }
        }

        return explorationLog.slice(0, 12000);
    } catch (e) {
        return '';
    }
}

async function callGeminiWithTools(messages, tools, signal) {
    const apiKey = config.gemini.apiKey;
    if (!apiKey) throw new Error('Chave Gemini não configurada');
    const model = _currentTaskModel || config.gemini.model || 'gemini-3.5';

    const systemMsg = messages[0]?.role === 'user' ? messages[0].content : '';
    const contents = messages.map((m, idx) => {
        if (m.role === 'tool') return { role: 'tool', parts: [{ text: m.content }] };
        if (m.role === 'assistant') return { role: 'model', parts: [{ text: m.content || '' }] };
        const userParts = [{ text: m.content }];
        if (idx === 0 && _pendingImages && _pendingImages.length) {
            for (const img of _pendingImages) {
                if (img.dataUrl) {
                    const match = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)/);
                    if (match) userParts.unshift({ inlineData: { mimeType: match[1], data: match[2] } });
                }
            }
            clearPendingImages();
        }
        return { role: 'user', parts: userParts };
    });

    const toolDeclarations = tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters.type === 'object' ? t.parameters : {
            type: 'object',
            properties: Object.fromEntries(Object.entries(t.parameters).map(([k, v]) => [k, { type: 'string', description: String(v) }])),
            required: Object.keys(t.parameters)
        }
    }));

    return new Promise((resolve, reject) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = JSON.stringify({
            systemInstruction: { parts: [{ text: systemMsg }] },
            contents: contents.slice(1),
            tools: [{ functionDeclarations: toolDeclarations }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
        });

        const abort = new AbortController();
        if (signal) signal.addEventListener('abort', () => abort.abort());

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: abort.signal
        }).then(async (res) => {
            if (!res.ok) {
                const err = await res.text();
                throw new Error(`Gemini HTTP ${res.status}: ${err.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.usageMetadata) {
                const cacheHit = data.usageMetadata.cachedContentTokenCount || 0;
                trackTokens('gemini', data.usageMetadata.promptTokenCount || 0, data.usageMetadata.candidatesTokenCount || 0, cacheHit > 0, model, cacheHit);
            }
            const candidate = data.candidates?.[0];
            const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';

            const toolCalls = [];
            for (const part of (candidate?.content?.parts || [])) {
                if (part.functionCall) {
                    toolCalls.push({
                        id: `call_${Date.now()}_${toolCalls.length}`,
                        name: part.functionCall.name,
                        args: part.functionCall.args || {}
                    });
                }
            }

            resolve({ text, toolCalls });
        }).catch(reject);
    });
}

async function callDeepSeekWithTools(messages, tools, signal) {
    const apiKey = config.deepseek.apiKey;
    if (!apiKey) throw new Error('Chave DeepSeek não configurada');
    const model = _currentTaskModel || config.deepseek.model || 'deepseek-v4-flash';

    const toolDefs = tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters.type === 'object' ? t.parameters : {
                type: 'object',
                properties: Object.fromEntries(Object.entries(t.parameters).map(([k, v]) => [k, { type: 'string', description: String(v) }])),
                required: Object.keys(t.parameters)
            }
        }
    }));

    const formattedMessages = messages.map(m => ({
        role: m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || '',
        ...(m.role === 'tool' ? { tool_call_id: m.tool_call_id } : {})
    }));

    return new Promise((resolve, reject) => {
        const url = new URL('https://api.deepseek.com/chat/completions');
        const body = JSON.stringify({
            model,
            messages: formattedMessages,
            tools: toolDefs,
            temperature: 0.3,
            max_tokens: 4096
        });

        const abort = new AbortController();
        if (signal) signal.addEventListener('abort', () => abort.abort());

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body,
            signal: abort.signal
        }).then(async (res) => {
            if (!res.ok) {
                const err = await res.text();
                throw new Error(`DeepSeek HTTP ${res.status}: ${err.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.usage) {
                const cacheHit = data.usage.prompt_cache_hit_tokens || data.usage.prompt_tokens_details?.cached_tokens || 0;
                trackTokens('deepseek', data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cacheHit > 0, model, cacheHit);
            }
            const msg = data.choices?.[0]?.message;
            const toolCalls = [];
            if (msg?.tool_calls) {
                for (const tc of msg.tool_calls) {
                    toolCalls.push({
                        id: tc.id,
                        name: tc.function?.name,
                        args: JSON.parse(tc.function?.arguments || '{}')
                    });
                }
            }
            resolve({ text: msg?.content || '', toolCalls });
        }).catch(reject);
    });
}

function classifyRequest(message) {
    const m = (message || '').trim();
    const mLower = m.toLowerCase();

    const intent = classifyIntent(message);

    if (intent === 'question') return { route: 'answer', reason: 'Pergunta detectada' };

    const simplePatterns = [
        /^(corrig(a|ir)|arrum(a|ar)|consert(a|ar)|fix)\s/i,
        /^(adicione|adicionar|acrescent(a|ar)|inclu(a|ir))\s.+\s(no|na|em|ao)\s/i,
        /^(remova|remover|delete|deletar|apag(a|ar)|exclu(a|ir))\s/i,
        /^(renomei(a|ar)|renomear|mova|mover|move)\s/i,
        /^(troque|trocar|altere|alterar|mude|mudar|substitua|substituir)\s.+\s(por|para)\s/i,
        /^(crie|criar|faça|fazer|implemente|implementar)\s.+\s(com|usando|que)\s/i,
        /^(execute|executar|rode|rodar|teste|testar)\s/i,
        /^(atualize|atualizar|refatore|refatorar)\s\w+\s/i,
        /^(formate|formatar|lint|organize|organizar)\s/i,
        /^(adicione|adicionar|coloque|colocar|ponha|pôr)\s.+\s(no|na|antes|depois|após)\s/i,
        /^(extraia|extrair|separe|separar|divida|dividir)\s/i,
        /^(converta|converter|transforme|transformar)\s/i,
    ];

    for (const pattern of simplePatterns) {
        if (pattern.test(mLower)) return { route: 'direct', reason: 'Tarefa específica detectada' };
    }

    const complexSignals = [
        /\?/g,
        /\b(ou|ou então|alternativa|opção|opções|escolha|escolher|qual|como)\b/gi,
        /\b(qualquer|tanto faz|decida|decidir|sugira|sugerir|recomende|recomendar)\b/gi,
        /\b(melhorar|melhore|aprimorar|aprimore|otimizar|otimize)\b/gi,
    ];
    let complexityScore = 0;
    for (const sig of complexSignals) {
        const matches = mLower.match(sig);
        if (matches) complexityScore += matches.length;
    }

    if (mLower.length < 30) complexityScore += 3;
    if (mLower.includes('melhorar') && !mLower.includes('arquivo') && !mLower.includes('função')) complexityScore += 2;
    if (mLower.split(/\s+/).length > 40) complexityScore -= 2;

    if (complexityScore >= 3) return { route: 'options', reason: 'Pedido complexo/aberto — gerar opções' };

    if (mLower.length > 100 || mLower.split(',').length > 3 || mLower.split(';').length > 2) {
        return { route: 'direct', reason: 'Múltiplas tarefas específicas' };
    }

    return { route: 'direct', reason: 'Tarefa direta padrão' };
}

async function analyzeTask(message, onChunk, signal, mode = 'cowork', history = [], provider = 'gemini', explorationContext = '') {
    const intent = classifyIntent(message);
    const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.cowork;
    const projectRules = loadProjectRules();

    const historyText = (history && history.length)
        ? history.slice(-15).map(h => `- ${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(h.content || '').slice(0, 800)}`).join('\n')
        : '(sem histórico)';

    const isQuestion = intent === 'question';
    const relevantFiles = isQuestion ? {} : getRelevantFileContents(message);
    const projectSummary = isQuestion ? '' : getProjectCache();

    if (isQuestion) {
        if (onChunk) onChunk('Sistema', '💡 Pergunta detectada: respondendo sem análise de arquivos\n');
    }

    console.log(`📁 Projeto: ${PROJECT_ROOT}`);
    console.log(`📄 Arquivos no contexto: ${Object.keys(relevantFiles).length} (intenção: ${intent})`);

    const projectCtx = isQuestion
        ? `DIRETÓRIO: ${PROJECT_ROOT}\n\nESTRUTURA DO PROJETO:\n${getFileTree('') || '(pasta vazia)'}`
        : `DIRETÓRIO: ${PROJECT_ROOT}\n\nESTRUTURA DO PROJETO:\n${projectSummary || getFileTree('') || '(pasta vazia)'}`;

    const analysisPrompt = `⚠️ REGRA ABSOLUTA: Sua ÚNICA resposta deve ser um OBJETO JSON puro, começando com { e terminando com }. NADA de texto antes ou depois. NADA de markdown. NADA de explicações fora do JSON. Se você responder com texto em vez de JSON, o sistema quebrará.

Você é o Aedificator Codex IDE. O código é uma arte: respeite a estrutura existente.
${LANGUAGE_RULE}

${getQualityRules()}

${explorationContext ? '📖 EXPLORAÇÃO PRÉVIA DO CÓDIGO (o agente já leu os seguintes arquivos):\n' + explorationContext + '\n' : ''}

${projectCtx}

${projectRules ? 'REGRAS DO PROJETO (.aedificator-agents.md):\n' + projectRules + '\n' : ''}${isQuestion ? '' : '\nARQUIVOS RELEVANTES:\n' + formatRelevantFiles(relevantFiles)}

SOLICITAÇÃO DO USUÁRIO: "${message}"

MODO: ${modeInstruction}

HISTÓRICO:
${historyText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMATOS DE RESPOSTA (escolha UM):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FORMATO A — Apenas se o pedido for AMBÍGUO e você PRECISAR perguntar algo (ex: "cria um app" sem dizer o que faz):
{
  "resumo": "Preciso de uma informação",
  "sugestoes": [
    {"id":"q1","titulo":"Pergunta","descricao":"O que você quer que o app faça?","impacto":"médio","arquivos":[]}
  ]
}

FORMATO B — Para pedidos CLAROS de correção, alteração ou implementação:
{
  "resumo": "Resumo do que será feito (1-2 frases)",
  "arquivos": [
    { "caminho": "src/index.js", "acao": "modificar", "explicacao": "o que mudar neste arquivo" },
    { "caminho": "src/novo.js", "acao": "criar", "explicacao": "o que este arquivo fará" }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGRAS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- ⚠️ NUNCA inclua o conteúdo dos arquivos (conteudo). O agente escreverá o código depois.
- ⚠️ Se o pedido é claro: SEMPRE use FORMATO B com caminho + acao + explicacao.
- ⚠️ Se for CRIAÇÃO de app NOVO: primeiro crie APP_SPEC.md, depois implemente módulo por módulo.
- ⚠️ Só use FORMATO A se realmente não souber o que fazer e precisar perguntar.
- ⚠️ "resumo": 1-2 frases curtas, conversacionais.`;

    if (onChunk) onChunk('Assistente', '🔍 Analisando estrutura do projeto...\n');

    const response = await callAI(provider, analysisPrompt, null, signal);

    const plan = extractJson(response);
    if (!plan) {
        if (onChunk) onChunk('Assistente', response || '');
        return { resumo: '', arquivos: [], _rawResponse: response };
    }

    if (plan.resumo && plan.resumo.length > 300) plan.resumo = plan.resumo.slice(0, 300) + '...';
    if (Array.isArray(plan.sugestoes)) {
        for (const s of plan.sugestoes) {
            if (s.titulo && s.titulo.length > 120) s.titulo = s.titulo.slice(0, 120) + '...';
            if (s.descricao && s.descricao.length > 300) s.descricao = s.descricao.slice(0, 300) + '...';
        }
    }
    if (Array.isArray(plan.arquivos)) {
        for (const a of plan.arquivos) {
            if (a.conteudo && a.conteudo.length > 200) a.conteudo = a.conteudo.slice(0, 200) + '... [CONTEÚDO TRUNCADO - o agente gerará o código]';
            if (a.explicacao && a.explicacao.length > 200) a.explicacao = a.explicacao.slice(0, 200) + '...';
        }
    }

    if (onChunk) {
        const resumo = String(plan.resumo || '').trim();
        if (resumo) onChunk('Assistente', '📋 ' + resumo + '\n');
    }

    if (Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0) {
        for (const sugestao of plan.sugestoes) {
            if (!sugestao.titulo) throw new Error('Sugestão sem título.');
            if (!Array.isArray(sugestao.arquivos)) sugestao.arquivos = [];
            for (const arquivo of sugestao.arquivos) {
                if (!arquivo.caminho) throw new Error('Sugestão com arquivo sem caminho.');
                if (!['criar', 'modificar', 'deletar'].includes(arquivo.acao)) {
                    arquivo.acao = 'modificar';
                }
            }
        }
        plan.arquivos = [];
        plan._rawResponse = response;
        return plan;
    }

    if (!Array.isArray(plan.arquivos)) {
        return { resumo: plan.resumo || '', arquivos: [], _rawResponse: response };
    }

    for (const arquivo of plan.arquivos) {
        if (!arquivo.caminho) throw new Error('Plano com arquivo sem caminho.');
        if (!['criar', 'modificar', 'deletar'].includes(arquivo.acao)) {
            arquivo.acao = 'modificar';
        }
    }

    plan._rawResponse = response;
    return plan;
}

// =============================================
//  EXECUÇÃO DO PLANO
// =============================================
async function executePlan(plan, onChunk, signal) {
    let result = `📋 **PLANO DE EXECUÇÃO**\n\n`;
    result += `📌 **Resumo:** ${plan.resumo || 'Executando alterações...'}\n\n`;
    result += `📁 **Diretório:** ${PROJECT_ROOT}\n\n`;

    if (onChunk) onChunk('Assistente', '\n📋 Executando alterações...\n');
    if (onChunk) onChunk('plan', String(plan.arquivos.length));

    const arquivos = plan.arquivos || [];
    const modifications = [];
    let cancelled = false;

    const phases = { criar: [], modificar: [], deletar: [] };
    for (const a of arquivos) {
        const acao = a.acao || 'modificar';
        (phases[acao] || phases.modificar).push(a);
    }

    for (const a of phases.deletar) {
        if (signal && signal.aborted) { cancelled = true; break; }
        backupRelativePath(a.caminho);
        if (onChunk) onChunk('Sistema', `🗑️ ${a.caminho}\n`);
        if (onChunk) onChunk('file-status', JSON.stringify([{ file: a.caminho, action: 'deletar', status: 'editing' }]));
        modifications.push({ file: a.caminho, action: 'deletar', status: 'pending', before: readProjectFileContent(a.caminho), after: '' });
    }

    if (!cancelled) {
        for (const a of phases.modificar) {
            backupRelativePath(a.caminho);
            if (onChunk) onChunk('file-status', JSON.stringify([{ file: a.caminho, action: 'modificar', status: 'editing' }]));
            modifications.push({ file: a.caminho, action: 'modificar', status: 'pending', before: readProjectFileContent(a.caminho), after: a.conteudo });
        }
        for (const a of phases.criar) {
            if (onChunk) onChunk('file-status', JSON.stringify([{ file: a.caminho, action: 'criar', status: 'editing' }]));
            modifications.push({ file: a.caminho, action: 'criar', status: 'pending', before: '', after: a.conteudo });
        }
    }

    if (!cancelled) {
        const writeOps = phases.deletar.map(a => (async () => {
            const ok = deleteFileContent(a.caminho);
            const m = modifications.find(m => m.file === a.caminho);
            if (m) m.status = ok ? 'deleted' : 'normal';
        })());
        writeOps.push(...phases.modificar.map(a => (async () => {
            const ok = writeFileContent(a.caminho, a.conteudo);
            const m = modifications.find(m => m.file === a.caminho);
            if (m) m.status = ok ? 'modified' : 'normal';
        })()));
        writeOps.push(...phases.criar.map(a => (async () => {
            const ok = writeFileContent(a.caminho, a.conteudo);
            const m = modifications.find(m => m.file === a.caminho);
            if (m) m.status = ok ? 'created' : 'normal';
        })()));

        try { await Promise.all(writeOps); } catch (e) {
            if (onChunk) onChunk('Sistema', `❌ Erro paralelo: ${e.message}\n`);
        }
    }

    for (const mod of modifications) {
        const icon = mod.status === 'created' ? '🆕' : mod.status === 'deleted' ? '🗑️' : mod.status === 'modified' ? '✏️' : '❌';
        if (onChunk) onChunk('Sistema', `${icon} ${mod.file} (${mod.status})\n`);
        const payload = { file: mod.file, action: mod.action, status: mod.status };
        // Para arquivos criados/modificados, atualiza o "after" real do disco.
        if (mod.action === 'criar' || mod.action === 'modificar') {
            payload.before = mod.before;
            payload.after = mod.status === 'normal' ? mod.after : readProjectFileContent(mod.file);
        } else {
            payload.before = mod.before;
            payload.after = '';
        }
        if (onChunk) onChunk('file-status', JSON.stringify([payload]));
    }

    if (cancelled) {
        result += `\n⏹️ **Tarefa cancelada** (${modifications.length} arquivo(s) processado(s)).\n`;
    } else {
        result += `\n✅ **${modifications.length} arquivo(s) processado(s) em paralelo!**\n`;
    }

    if (modifications.length > 0) {
        analyzer.invalidateIndex();
        invalidateProjectCache();
    }

    return result;
}

// =============================================
//  ROTAS DA API
// =============================================

app.get('/api/browser/status', (req, res) => {
    res.json(getBrowserStatus());
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: BACKEND_PROTOCOL_VERSION });
});

app.post('/api/init', async (req, res) => {
    const { projectPath } = req.body;
    if (projectPath) {
        const success = setProjectRoot(projectPath);
        if (success) {
            const repo = await detectRepo();
            const lastTag = repo.isRepo ? await latestVersionTag() : null;
            res.json({
                success: true,
                message: `Projeto alterado para: ${PROJECT_ROOT}`,
                repo: { ...repo, latestTag: lastTag, nextTag: nextVersion(lastTag) }
            });
            return;
        }
        return res.status(400).json({ error: 'Diretório não encontrado' });
    }
    const repo = await detectRepo();
    res.json({ success: true, message: `Projeto: ${PROJECT_ROOT}`, repo });
});

// ===== CRIAR NOVO PROJETO (PASTA ABSOLUTA) =====
app.post('/api/project/create', (req, res) => {
    const { path: absPath } = req.body;
    if (!absPath) return res.status(400).json({ error: 'Caminho não especificado' });
    const resolved = path.resolve(absPath);
    try {
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
        }
        if (!fs.statSync(resolved).isDirectory()) {
            return res.status(400).json({ error: 'Caminho já existe e não é uma pasta' });
        }
        res.json({ success: true, path: resolved });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao criar pasta: ' + e.message });
    }
});

app.post('/api/config', (req, res) => {
    const { geminiKey, deepseekKey, opencodeKey, openaiKey, claudeKey, openaiModel, claudeModel, deepseekModel, autoCommit } = req.body;
    if (geminiKey && geminiKey !== '********') config.gemini.apiKey = geminiKey;
    if (deepseekKey && deepseekKey !== '********') config.deepseek.apiKey = deepseekKey;
    if (opencodeKey && opencodeKey !== '********') {
        config.opencode.apiKey = opencodeKey;
        ensureOpenCodeAuth(opencodeKey);
    }
    if (openaiKey && openaiKey !== '********') config.openai.apiKey = openaiKey;
    if (openaiModel) config.openai.model = openaiModel;
    if (claudeKey && claudeKey !== '********') config.claude.apiKey = claudeKey;
    if (claudeModel) config.claude.model = claudeModel;
    if (deepseekModel) config.deepseek.model = normalizeDeepseekModel(deepseekModel);
    if (autoCommit !== undefined) config.autoCommit = !!autoCommit;

    try {
        saveConfigToFile();
        res.json({ success: true, message: 'Configuração salva!' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/config/get', (req, res) => {
    res.json({
        success: true,
        gemini: config.gemini.apiKey ? '********' : '',
        deepseek: config.deepseek.apiKey ? '********' : '',
        opencode: config.opencode.apiKey || getOpenCodeAuthKey() ? '********' : '',
        openai: config.openai.apiKey ? '********' : '',
        claude: config.claude.apiKey ? '********' : '',
        openaiModel: config.openai.model || '',
        claudeModel: config.claude.model || '',
        deepseekModel: config.deepseek.model || 'deepseek-v4-flash',
        autoCommit: config.autoCommit
    });
});

app.get('/api/config/status', (req, res) => {
    res.json({
        gemini: { configured: !!config.gemini.apiKey },
        deepseek: { configured: !!config.deepseek.apiKey },
        opencode: { configured: !!config.opencode.apiKey || !!getOpenCodeAuthKey() },
        openai: { configured: !!config.openai.apiKey },
        claude: { configured: !!config.claude.apiKey }
    });
});

app.get('/api/config/permissions', (req, res) => {
    res.json({ success: true, ask: config.toolPermissions.ask || [], grants: config.toolPermissions.grants || {} });
});

app.post('/api/config/permissions', (req, res) => {
    const { ask } = req.body || {};
    if (Array.isArray(ask)) config.toolPermissions.ask = ask;
    try {
        saveConfigToFile();
        res.json({ success: true, ask: config.toolPermissions.ask, grants: config.toolPermissions.grants });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/config/permissions/reset', (req, res) => {
    config.toolPermissions.grants = {};
    try {
        saveConfigToFile();
        res.json({ success: true, message: 'Permissões resetadas' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/usage', (req, res) => {
    const provider = req.query.provider || '';
    const model = req.query.model || '';
    res.json(getUsageReport(provider, model));
});

app.get('/api/usage/monthly', (req, res) => {
    const result = { months: [], total_brl: 0, providers: {} };
    const monthsSet = new Set();
    for (const [p, data] of Object.entries(tokenUsage)) {
        if (!data.monthly) continue;
        for (const month of Object.keys(data.monthly)) monthsSet.add(month);
        if (data.models) {
            for (const mu of Object.values(data.models)) {
                if (mu.monthly) for (const month of Object.keys(mu.monthly)) monthsSet.add(month);
            }
        }
    }
    for (const month of monthsSet) {
        result.months.push({ month, providers: {}, cost_brl: 0 });
    }
    for (const [p, data] of Object.entries(tokenUsage)) {
        if (!data.monthly) continue;
        for (const [month, usage] of Object.entries(data.monthly)) {
            let usd = 0;
            let counted = { input: 0, cache: 0, output: 0 };
            if (data.models) {
                for (const [model, mu] of Object.entries(data.models)) {
                    const mUsage = mu.monthly && mu.monthly[month];
                    if (!mUsage) continue;
                    usd += calcCost(getModelPrice(p, model), mUsage.input || 0, mUsage.cache || 0, mUsage.output || 0);
                    counted.input += mUsage.input || 0;
                    counted.cache += mUsage.cache || 0;
                    counted.output += mUsage.output || 0;
                }
            }
            const residInput = Math.max(0, (usage.input || 0) - counted.input);
            const residCache = Math.max(0, (usage.cache || 0) - counted.cache);
            const residOutput = Math.max(0, (usage.output || 0) - counted.output);
            if (residInput || residCache || residOutput) {
                usd += calcCost(getModelPrice(p, null), residInput, residCache, residOutput);
            }
            const brl = round2(usd * USD_TO_BRL);
            const monthEntry = result.months.find(m => m.month === month);
            monthEntry.providers[p] = {
                tokens: { input: usage.input || 0, output: usage.output || 0, cache: usage.cache || 0 },
                cost_usd: round4(usd),
                cost_brl: brl
            };
            monthEntry.cost_brl += brl;
            result.total_brl += brl;
            if (!result.providers[p]) result.providers[p] = { total_brl: 0 };
            result.providers[p].total_brl += brl;
        }
    }
    result.months.sort((a, b) => b.month.localeCompare(a.month));
    result.total_brl = round2(result.total_brl);
    res.json(result);
});

app.post('/api/pricing/refresh', async (req, res) => {
    try {
        const prices = await fetchAiPrices(true);
        res.json({ success: true, prices, usdBrl: USD_TO_BRL });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/pricing', (req, res) => {
    res.json({ usdBrl: USD_TO_BRL, prices: TOKEN_PRICES });
});

app.post('/api/pricing', (req, res) => {
    const { usdBrl, prices } = req.body;
    if (usdBrl && usdBrl > 0) USD_TO_BRL = usdBrl;
    if (prices) {
        for (const [p, v] of Object.entries(prices)) {
            if (TOKEN_PRICES[p]) {
                if (v['__default']) TOKEN_PRICES[p]['__default'] = v['__default'];
                if (v.models && Object.keys(v.models).length > 0) {
                    if (!TOKEN_PRICES[p].models) TOKEN_PRICES[p].models = {};
                    Object.assign(TOKEN_PRICES[p].models, v.models);
                }
            }
        }
    }
    try {
        savePricingFile({ usdBrl: USD_TO_BRL, prices: TOKEN_PRICES });
    } catch (e) {}
    res.json({ success: true, usdBrl: USD_TO_BRL, prices: TOKEN_PRICES });
});

try {
    const pricingFile = path.join(__dirname, 'pricing.json');
    if (fs.existsSync(pricingFile)) {
        const saved = JSON.parse(fs.readFileSync(pricingFile, 'utf-8'));
        if (saved.usdBrl) USD_TO_BRL = saved.usdBrl;
        if (saved.prices) Object.assign(TOKEN_PRICES, saved.prices);
    }
} catch (e) {}

app.get('/api/models/opencode', async (req, res) => {
    try {
        const models = await listOpenCodeFreeModels();
        res.json({ success: true, models });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== LISTAR TODOS OS MODELOS OPEncode (sem filtro free) =====
app.get('/api/models/opencode-all', async (req, res) => {
    try {
        const models = await listOpenCodeModels(true);
        res.json({ success: true, models });
    } catch (e) {
        res.json({
            success: true,
            models: [
                { id: 'opencode/anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: 'Anthropic', free: true },
                { id: 'opencode/anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'Anthropic', free: true },
                { id: 'opencode/deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', free: false },
                { id: 'opencode/deepseek/deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek', free: true },
                { id: 'opencode/openai/gpt-5.2', name: 'GPT-5.2', provider: 'OpenAI', free: false },
                { id: 'opencode/openai/gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI', free: false },
                { id: 'opencode/gemini/gemini-3.0-flash', name: 'Gemini 3.0 Flash', provider: 'Gemini', free: true },
                { id: 'opencode/gemini/gemini-3.0-pro', name: 'Gemini 3.0 Pro', provider: 'Gemini', free: false }
            ]
        });
    }
});

// ===== LEITURA/ESCRITA DE ARQUIVOS (EDITOR) =====
app.post('/api/file/read', (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'Caminho não especificado' });

    const full = resolveSafePath(filePath);
    if (!full) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    const stats = fs.statSync(full);
    if (stats.size > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Arquivo grande demais para o editor (máx. 5MB)' });
    }

    try {
        const content = fs.readFileSync(full, 'utf-8');
        res.json({ success: true, content, name: path.basename(full), path: filePath });
    } catch (e) {
        res.status(500).json({ error: 'Não foi possível ler o arquivo (pode ser binário)' });
    }
});

app.post('/api/file/write', (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'Caminho não especificado' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'Conteúdo inválido' });

    const existing = resolveSafePath(filePath);
    if (existing && fs.existsSync(existing) && !fs.statSync(existing).isDirectory()) {
        backupRelativePath(filePath);
    }

    const ok = writeFileContent(filePath, content);
    if (!ok) return res.status(400).json({ error: 'Falha ao escrever arquivo' });
    res.json({ success: true, message: 'Arquivo salvo!' });
});

app.post('/api/file/create', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'Caminho não especificado' });
    const full = resolveSafePath(filePath);
    if (!full) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (fs.existsSync(full)) return res.status(409).json({ error: 'Já existe um arquivo com este nome' });
    try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '', 'utf-8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao criar arquivo: ' + e.message });
    }
});

app.post('/api/file/mkdir', (req, res) => {
    const { path: dirPath } = req.body || {};
    if (!dirPath) return res.status(400).json({ error: 'Caminho não especificado' });
    const full = resolveSafePath(dirPath);
    if (!full) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (fs.existsSync(full)) return res.status(409).json({ error: 'Já existe uma pasta com este nome' });
    try {
        fs.mkdirSync(full, { recursive: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao criar pasta: ' + e.message });
    }
});

app.post('/api/file/rename', (req, res) => {
    const { path: oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'Caminhos não especificados' });
    const fullOld = resolveSafePath(oldPath);
    const fullNew = resolveSafePath(newPath);
    if (!fullOld || !fullNew) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'Origem não encontrada' });
    if (fs.existsSync(fullNew)) return res.status(409).json({ error: 'Já existe um arquivo/pasta com o novo nome' });
    try {
        fs.mkdirSync(path.dirname(fullNew), { recursive: true });
        fs.renameSync(fullOld, fullNew);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao renomear: ' + e.message });
    }
});

app.post('/api/file/delete', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'Caminho não especificado' });
    const full = resolveSafePath(filePath);
    if (!full) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Arquivo/pasta não encontrado' });
    try {
        const stats = fs.statSync(full);
        if (stats.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
        } else {
            backupRelativePath(filePath);
            fs.unlinkSync(full);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao excluir: ' + e.message });
    }
});

app.post('/api/file/move', (req, res) => {
    const { path: oldPath, newPath } = req.body || {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'Caminhos não especificados' });
    const fullOld = resolveSafePath(oldPath);
    const fullNew = resolveSafePath(newPath);
    if (!fullOld || !fullNew) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'Origem não encontrada' });
    if (fs.existsSync(fullNew)) return res.status(409).json({ error: 'Já existe um arquivo/pasta com o novo nome' });
    try {
        fs.mkdirSync(path.dirname(fullNew), { recursive: true });
        fs.renameSync(fullOld, fullNew);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao mover: ' + e.message });
    }
});

// ===== BACKUP / RESTAURAR =====
app.post('/api/backup/list', (req, res) => {
    const files = listBackups();
    res.json({ success: true, files });
});

app.post('/api/backup/restore', (req, res) => {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });

    const backupFile = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, file);
    if (!fs.existsSync(backupFile) || fs.statSync(backupFile).isDirectory()) {
        return res.status(404).json({ error: 'Backup não encontrado' });
    }

    const targetRel = file.replace(/\.\d+$/, '');
    const safeTarget = resolveSafePath(targetRel);
    if (!safeTarget) return res.status(400).json({ error: 'Caminho fora do projeto' });

    try {
        fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
        fs.copyFileSync(backupFile, safeTarget);
        res.json({ success: true, message: 'Arquivo restaurado!', path: targetRel });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== UNDO / REDO =====
const undoStack = [];
const redoStack = [];

function pushUndoState(affectedFiles) {
    if (!Array.isArray(affectedFiles) || !affectedFiles.length) return;
    const entry = { timestamp: Date.now(), files: [] };
    for (const f of affectedFiles) {
        const fullPath = resolveSafePath(typeof f === 'string' ? f : f.caminho || f.file);
        if (!fullPath || !fs.existsSync(fullPath)) continue;
        try {
            entry.files.push({ path: typeof f === 'string' ? f : f.caminho || f.file, content: fs.readFileSync(fullPath, 'utf-8') });
        } catch (e) {}
    }
    if (entry.files.length) {
        undoStack.push(entry);
        if (undoStack.length > 50) undoStack.shift();
        redoStack.length = 0;
    }
}

app.post('/api/undo', (req, res) => {
    if (!undoStack.length) return res.json({ success: false, message: 'Nada para desfazer' });
    const entry = undoStack.pop();
    const redoEntry = { timestamp: Date.now(), files: [] };
    for (const f of entry.files) {
        const fullPath = resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            if (fs.existsSync(fullPath)) {
                redoEntry.files.push({ path: f.path, content: fs.readFileSync(fullPath, 'utf-8') });
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
        } catch (e) {}
    }
    if (redoEntry.files.length) redoStack.push(redoEntry);
    broadcastAll({ type: 'refresh' });
    broadcastAll({ type: 'undo-done', message: `${entry.files.length} arquivo(s) restaurado(s)` });
    res.json({ success: true, files: entry.files.length, message: `${entry.files.length} arquivo(s) restaurado(s)` });
});

app.post('/api/redo', (req, res) => {
    if (!redoStack.length) return res.json({ success: false, message: 'Nada para refazer' });
    const entry = redoStack.pop();
    const undoEntry = { timestamp: Date.now(), files: [] };
    for (const f of entry.files) {
        const fullPath = resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            if (fs.existsSync(fullPath)) {
                undoEntry.files.push({ path: f.path, content: fs.readFileSync(fullPath, 'utf-8') });
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
        } catch (e) {}
    }
    if (undoEntry.files.length) undoStack.push(undoEntry);
    broadcastAll({ type: 'refresh' });
    broadcastAll({ type: 'redo-done', message: `${entry.files.length} arquivo(s) refeito(s)` });
    res.json({ success: true, files: entry.files.length, message: `${entry.files.length} arquivo(s) refeito(s)` });
});

app.post('/api/undo/status', (req, res) => {
    res.json({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoCount: undoStack.length, redoCount: redoStack.length });
});

async function undoLastChange() {
    if (!undoStack.length) return null;
    const entry = undoStack.pop();
    const redoEntry = { timestamp: Date.now(), files: [] };
    for (const f of entry.files) {
        const fullPath = resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            if (fs.existsSync(fullPath)) {
                redoEntry.files.push({ path: f.path, content: fs.readFileSync(fullPath, 'utf-8') });
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
        } catch (e) {}
    }
    if (redoEntry.files.length) redoStack.push(redoEntry);
    broadcastAll({ type: 'refresh' });
    return `${entry.files.length} arquivo(s) restaurado(s)`;
}

async function redoLastChange() {
    if (!redoStack.length) return null;
    const entry = redoStack.pop();
    const undoEntry = { timestamp: Date.now(), files: [] };
    for (const f of entry.files) {
        const fullPath = resolveSafePath(f.path);
        if (!fullPath) continue;
        try {
            if (fs.existsSync(fullPath)) {
                undoEntry.files.push({ path: f.path, content: fs.readFileSync(fullPath, 'utf-8') });
            }
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, f.content, 'utf-8');
        } catch (e) {}
    }
    if (undoEntry.files.length) undoStack.push(undoEntry);
    broadcastAll({ type: 'refresh' });
    return `${entry.files.length} arquivo(s) refeito(s)`;
}

function copyDirContents(srcDir, dstDir, ignore) {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (ignore && ignore.has(entry.name)) continue;
        const src = path.join(srcDir, entry.name);
        const dst = path.join(dstDir, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(dst, { recursive: true });
            copyDirContents(src, dst, ignore);
        } else if (entry.isFile()) {
            try { fs.copyFileSync(src, dst); } catch (e) {}
        }
    }
}

function restoreSnapshot(label) {
    const root = SNAPSHOT_ROOT();
    const dir = path.join(root, label);
    if (!dir.startsWith(root) || !fs.existsSync(dir)) throw new Error('Snapshot não encontrado');
    let restored = 0;
    for (const rel of walkSnapshotFiles(dir)) {
        const src = path.join(dir, rel);
        const target = resolveSafePath(rel);
        if (!target) continue;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(src, target);
            restored++;
        } catch (e) {}
    }
    return restored;
}

// ===== SHARE =====
function escapeHtml(text) {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const sharedConversations = new Map();

app.post('/api/share', (req, res) => {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
        return res.status(400).json({ error: 'Nenhuma mensagem para compartilhar' });
    }
    const id = crypto.randomBytes(6).toString('hex');
    sharedConversations.set(id, { messages, createdAt: Date.now() });
    if (sharedConversations.size > 100) {
        const oldest = [...sharedConversations.keys()].sort((a, b) =>
            sharedConversations.get(a).createdAt - sharedConversations.get(b).createdAt)[0];
        sharedConversations.delete(oldest);
    }
    res.json({ success: true, id, url: `http://127.0.0.1:${PORT}/share/${id}` });
});

app.get('/share/:id', (req, res) => {
    const conv = sharedConversations.get(req.params.id);
    if (!conv) return res.status(404).send('<h2 style="color:#f85149;font-family:sans-serif;text-align:center;margin-top:60px;">Conversa não encontrada ou expirada</h2>');
    let html = `<!DOCTYPE html><html lang="pt"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Aedificator Codex - Conversa Compartilhada</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;padding:20px;max-width:900px;margin:0 auto}
h1{font-size:18px;color:#58a6ff;margin-bottom:8px;border-bottom:1px solid #30363d;padding-bottom:12px}
.msg{margin:8px 0;padding:10px 14px;border-radius:8px;line-height:1.5}
.msg.user{background:#1f6feb22;border-left:3px solid #58a6ff}
.msg.agent{background:#23863622;border-left:3px solid #3fb950}
.msg.system{background:#30363d44;border-left:3px solid #484f58;font-size:13px}
.role{font-size:10px;font-weight:700;text-transform:uppercase;margin-bottom:4px;opacity:0.7}
pre{background:#161b22;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px}
.footer{text-align:center;margin-top:24px;font-size:11px;color:#484f58}footer a{color:#58a6ff}
</style></head><body><h1>Aedificator Codex IDE - Conversa Compartilhada</h1>`;
    for (const m of conv.messages) {
        const role = m.role || 'system';
        html += `<div class="msg ${role}"><div class="role">${role === 'user' ? 'Usuário' : role === 'agent' ? 'Assistente' : 'Sistema'}</div>${escapeHtml(m.content).replace(/\n/g, '<br>').replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')}</div>`;
    }
    html += `<div class="footer">${new Date(conv.createdAt).toLocaleString()} · <a href="/">Aedificator Codex IDE</a></div></body></html>`;
    res.type('html').send(html);
});

// ===== SNAPSHOTS ROTULADOS (versões completas da pasta) =====
// Guarda cópias completas rotuladas em .aedificator-codex-ide-backup/snapshots/<rotulo>/,
// ignorando pastas grandes (node_modules, .git, dist, build) e binários maiores que o limite.
const SNAPSHOT_ROOT = () => path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots');
const SNAPSHOT_MAX_FILE = 10 * 1024 * 1024; // 10 MB por arquivo

function snapshotAll() {
    return snapshotProjectContents(); // Map relPath -> conteúdo (já filtra IGNORED_DIRS, binários e >3MB)
}

function sanitizeLabel(label) {
    const s = String(label || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_');
    return s.slice(0, 80) || 'snapshot';
}

app.post('/api/snapshot/create', (req, res) => {
    const { name, note } = req.body;
    const label = sanitizeLabel(name);
    const dir = path.join(SNAPSHOT_ROOT(), label);
    try {
        // se já existe, apaga para renomear a versão nova
        fs.rmSync(dir, { recursive: true, force: true });
        const files = snapshotAll();
        let copied = 0;
        for (const [relPath] of files) {
            const full = resolveSafePath(relPath);
            if (!full || !fs.existsSync(full)) continue;
            const target = path.join(dir, relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            try {
                fs.copyFileSync(full, target);
                copied++;
            } catch { /* ignora inúmeros */ }
        }
        fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({
            name: label, note: note || '', createdAt: Date.now(), files: copied
        }, null, 2));
        res.json({ success: true, message: `Snapshot "${label}" criado (${copied} arquivos)`, name: label });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/snapshot/list', (req, res) => {
    const root = SNAPSHOT_ROOT();
    const list = [];
    if (fs.existsSync(root)) {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const metaPath = path.join(root, entry.name, '.meta.json');
            let meta = { name: entry.name, note: '', createdAt: null, files: 0 };
            try {
                if (fs.existsSync(metaPath)) meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf-8')) };
                else meta.createdAt = fs.statSync(path.join(root, entry.name)).mtimeMs;
            } catch {}
            list.push(meta);
        }
    }
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ success: true, snapshots: list });
});

// Retorna o conteúdo de um arquivo dentro de um snapshot, de forma segura.
function readSnapshotFile(dir, relPath) {
    const target = path.resolve(dir, relPath);
    if (target !== dir && !target.startsWith(dir + path.sep)) return null;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
    return fs.readFileSync(target, 'utf-8');
}

// Lista os caminhos (relPath) presentes dentro de um snapshot.
function walkSnapshotFiles(dir) {
    const out = [];
    const walk = (d, rel) => {
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (entry.name === '.meta.json') continue;
            if (entry.isDirectory()) { walk(path.join(d, entry.name), rel ? `${rel}/${entry.name}` : entry.name); continue; }
            out.push(rel ? `${rel}/${entry.name}` : entry.name);
        }
    };
    walk(dir, '');
    return out;
}

app.post('/api/snapshot/diff', (req, res) => {
    const { name } = req.body;
    const label = sanitizeLabel(name);
    const root = SNAPSHOT_ROOT();
    const dir = path.join(root, label);
    if (!dir.startsWith(root) || !fs.existsSync(dir)) {
        return res.status(404).json({ error: 'Snapshot não encontrado' });
    }
    const changes = { modified: [], created: [], deleted: [], unchanged: 0 };
    const snapFiles = walkSnapshotFiles(dir);

    // arquivos no snapshot comparados com o projeto atual
    for (const rel of snapFiles) {
        const snapContent = readSnapshotFile(dir, rel);
        const full = resolveSafePath(rel);
        if (!full || !fs.existsSync(full)) {
            changes.deleted.push(rel); // existe no snapshot, não existe agora
            continue;
        }
        const cur = fs.readFileSync(full, 'utf-8');
        if (snapContent === null || snapContent === cur) changes.unchanged++;
        else changes.modified.push(rel);
    }
    // arquivos atuais que não existem no snapshot (criados depois)
    const currentFiles = snapshotAll();
    for (const rel of currentFiles.keys()) {
        const target = path.join(dir, rel);
        if (!fs.existsSync(target)) changes.created.push(rel);
    }
    res.json({ success: true, name: label, changes });
});

// Restaura um snapshot rotulado por cima do projeto atual.
app.post('/api/snapshot/restore', (req, res) => {
    const { name } = req.body;
    const label = sanitizeLabel(name);
    const root = SNAPSHOT_ROOT();
    const dir = path.join(root, label);
    if (!dir.startsWith(root) || !fs.existsSync(dir)) {
        return res.status(404).json({ error: 'Snapshot não encontrado' });
    }
    let restored = 0;
    for (const rel of walkSnapshotFiles(dir)) {
        const src = path.join(dir, rel);
        const target = resolveSafePath(rel);
        if (!target) continue;
        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(src, target);
            restored++;
        } catch {}
    }
    res.json({ success: true, message: `Snapshot "${label}" restaurado (${restored} arquivos)`, restored });
});

// ===== EXECUTAR COMANDOS =====
app.post('/api/run', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'Comando não especificado' });
    }

    const broadcastRun = (line) => {
        const payload = JSON.stringify({ type: 'run-output', line });
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(payload); } catch (e) {}
            }
        }
    };

    try {
        const { code, stdout, stderr } = await runner.runCommand({
            command,
            cwd: PROJECT_ROOT,
            onLine: broadcastRun
        });
        const output = stdout + (stderr ? (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr : '');
        res.json({ success: true, code, stdout, stderr, output });
    } catch (e) {
        res.status(500).json({ error: 'Falha ao executar: ' + e.message });
    }
});

// ===== TERMINAL PERSISTENTE (SHELL SESSION) =====
app.post('/api/shell/start', (req, res) => {
    const broadcast = (line) => {
        const payload = JSON.stringify({ type: 'run-output', line });
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) {
                try { client.send(payload); } catch (e) {}
            }
        }
    };
    try {
        const result = runner.startShellSession(PROJECT_ROOT, broadcast);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/shell/send', (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'Comando vazio' });
    try {
        const result = runner.sendToShell(command);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Remote shell: encaminha comando para o servidor remoto
app.post('/api/remote/shell', async (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'Comando vazio' });
    if (!remote.isConnected()) return res.status(400).json({ error: 'Nenhuma conexão remota ativa' });
    try {
        const result = await remote.execRemote(command);
        res.json({ success: true, output: result.stdout || result.stderr, cwd: '', code: result.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/shell/stop', (req, res) => {
    try {
        res.json(runner.stopShellSession());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== DOCKER =====
app.post('/api/docker/run', async (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'Comando Docker obrigatório' });
    if (!/^docker(\s|$)/.test(command.trim())) return res.status(400).json({ error: 'Apenas comandos docker são permitidos' });
    const validationError = validateAgentCommand(command);
    if (validationError) return res.status(400).json({ error: validationError });
    try {
        const result = await runner.runCommand({ command, cwd: PROJECT_ROOT, timeoutMs: 300000 });
        res.json({ success: true, output: result.stdout || result.stderr, code: result.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/docker/status', async (req, res) => {
    try {
        const r1 = await runner.runCommand({ command: 'docker --version', cwd: PROJECT_ROOT, timeoutMs: 5000 });
        const r2 = await runner.runCommand({ command: 'docker ps --format "{{.Names}}"', cwd: PROJECT_ROOT, timeoutMs: 5000 });
        const containers = r2.stdout ? r2.stdout.trim().split('\n').filter(Boolean) : [];
        res.json({ success: true, installed: r1.code === 0 && !!r1.stdout, containers });
    } catch (e) {
        res.json({ success: true, installed: false, containers: [] });
    }
});

// ===== REMOTE DEV (SSH) =====
app.post('/api/remote/connect', async (req, res) => {
    const { host, user, port, keyFile } = req.body || {};
    try {
        const result = await remote.connect({ host, user, port: port || 22, keyFile });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remote/disconnect', (req, res) => {
    res.json(remote.disconnect());
});

app.post('/api/remote/status', (req, res) => {
    res.json(remote.getStatus());
});

app.post('/api/remote/ls', async (req, res) => {
    const { path: remotePath } = req.body || {};
    try {
        const result = await remote.listDir(remotePath || '.');
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remote/exec', async (req, res) => {
    const { command } = req.body || {};
    if (!command) return res.status(400).json({ error: 'Comando obrigatório' });
    try {
        const result = await remote.execRemote(command);
        res.json({ success: true, output: result.stdout || result.stderr, code: result.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remote/upload', async (req, res) => {
    const { localPath, remotePath } = req.body || {};
    if (!localPath || !remotePath) return res.status(400).json({ error: 'Caminhos obrigatórios' });
    const fullLocal = resolveSafePath(localPath);
    if (!fullLocal) return res.status(400).json({ error: 'Caminho local fora do projeto' });
    try {
        const result = await remote.uploadFile(fullLocal, remotePath);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remote/download', async (req, res) => {
    const { remotePath, localPath } = req.body || {};
    if (!remotePath) return res.status(400).json({ error: 'Caminho remoto obrigatório' });
    const fullLocal = localPath ? (resolveSafePath(localPath) || path.join(PROJECT_ROOT || process.cwd(), path.basename(remotePath))) : path.join(PROJECT_ROOT || process.cwd(), path.basename(remotePath));
    try {
        const result = await remote.downloadFile(remotePath, fullLocal);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/remote/deploy', async (req, res) => {
    const { remotePath } = req.body || {};
    if (!remotePath) return res.status(400).json({ error: 'Caminho remoto obrigatório' });
    try {
        const result = await remote.deployProject(remotePath, PROJECT_ROOT);
        broadcastAll({ type: 'deploy-done', message: 'Deploy concluído: ' + remotePath });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== SETTINGS SYNC =====
const SETTINGS_FILE = () => path.join(PROJECT_ROOT, '.aedificator-settings.json');
const KEYBINDINGS_FILE = () => path.join(PROJECT_ROOT, '.aedificator-keybindings.json');

app.post('/api/settings/export', (req, res) => {
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    try {
        const { settings } = req.body || {};
        if (!settings && !req.body.id) return res.status(400).json({ error: 'Envie as configurações como { settings: {...} }' });
        const toSave = settings || req.body;
        toSave.exportedAt = new Date().toISOString();
        fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(toSave, null, 2), 'utf-8');
        res.json({ success: true, file: '.aedificator-settings.json' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings/import', (req, res) => {
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    try {
        const file = SETTINGS_FILE();
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Arquivo .aedificator-settings.json não encontrado. Exporte primeiro.' });
        const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
        res.json({ success: true, settings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/keybindings/list', (req, res) => {
    if (!PROJECT_ROOT) return res.json({ success: true, bindings: [] });
    try {
        const file = KEYBINDINGS_FILE();
        let bindings = [];
        if (fs.existsSync(file)) {
            bindings = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
        res.json({ success: true, bindings });
    } catch (e) {
        res.json({ success: true, bindings: [] });
    }
});

app.post('/api/keybindings/save', (req, res) => {
    const { bindings } = req.body || {};
    if (!PROJECT_ROOT || !Array.isArray(bindings)) return res.status(400).json({ error: 'Dados inválidos' });
    try {
        fs.writeFileSync(KEYBINDINGS_FILE(), JSON.stringify(bindings, null, 2), 'utf-8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== TAREFAS DE BUILD =====
const TASKS_FILE = () => path.join(PROJECT_ROOT, '.aedificator-tasks.json');

app.post('/api/tasks/list', (req, res) => {
    const file = TASKS_FILE();
    let tasks = [];
    try {
        if (fs.existsSync(file)) {
            tasks = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
    } catch (e) {}
    res.json({ success: true, tasks });
});

app.post('/api/tasks/save', (req, res) => {
    const { tasks } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Lista de tarefas inválida' });
    try {
        fs.writeFileSync(TASKS_FILE(), JSON.stringify(tasks, null, 2), 'utf-8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================
//  ANALYZER — validação e indexação de código
// =============================================
app.post('/api/analyzer/validate', (req, res) => {
    const { code, file: filePath } = req.body || {};
    if (!code || !filePath) return res.status(400).json({ error: 'Código e caminho do arquivo são obrigatórios' });
    try {
        const ext = (path.extname(filePath) || '.js').toLowerCase();
        const isTS = ['.ts', '.tsx'].includes(ext);
        const isPy = ['.py', '.pyw'].includes(ext);
        const isGo = ['.go'].includes(ext);
        const isCpp = ['.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hh'].includes(ext);
        const isRs = ext === '.rs';
        let errors = [];
        const fullPath = resolveSafePath(filePath);
        if (fullPath) {
            try { fs.writeFileSync(fullPath, code, 'utf-8'); } catch (e) {}
        }
        if (isTS && fullPath) {
            try {
                errors = analyzer.validateWithTSProgram(filePath, PROJECT_ROOT);
            } catch (e) {
                errors.push({ type: 'typescript', line: 1, column: 1, message: 'Type-check indisponível: ' + e.message, severity: 'warning' });
            }
        } else if (isPy && fullPath) {
            try {
                errors = analyzer.validateWithPythonAST(filePath, PROJECT_ROOT);
            } catch (e) {
                errors.push({ type: 'python', line: 1, column: 1, message: 'Python AST falhou: ' + e.message, severity: 'warning' });
            }
        } else if (isGo && fullPath) {
            try {
                errors = analyzer.validateWithGoVet(filePath, PROJECT_ROOT);
            } catch (e) {
                errors.push({ type: 'go', line: 1, column: 1, message: 'go vet falhou: ' + e.message, severity: 'warning' });
            }
        } else if (isCpp && fullPath) {
            try {
                errors = analyzer.validateWithGCC(filePath, PROJECT_ROOT);
            } catch (e) {
                errors.push({ type: 'c/c++', line: 1, column: 1, message: 'gcc indisponível: ' + e.message, severity: 'warning' });
            }
        } else if (isRs && fullPath) {
            try {
                errors = analyzer.validateWithRustc(filePath, PROJECT_ROOT);
            } catch (e) {
                errors.push({ type: 'rust', line: 1, column: 1, message: 'rustc indisponível: ' + e.message, severity: 'warning' });
            }
        }
        if (!errors.length) {
            const result = analyzer.validateCode(code, filePath, PROJECT_ROOT);
            errors = result.errors;
        }
        const valid = errors.filter(e => e.severity === 'error').length === 0;
        const fixes = errors.length ? analyzer.suggestFix(errors[0], code) : [];
        res.json({ errors, valid, filePath, suggestionCount: errors.filter(e => e.severity === 'warning').length, fixes });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/ts-symbols', (req, res) => {
    const { file } = req.body || {};
    if (!PROJECT_ROOT || !file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const symbols = analyzer.getTSSymbols(file, PROJECT_ROOT);
        res.json({ success: true, symbols });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/python-symbols', (req, res) => {
    const { file } = req.body || {};
    if (!PROJECT_ROOT || !file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const symbols = analyzer.getPythonSymbols(file, PROJECT_ROOT);
        res.json({ success: true, symbols });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/python-validate', (req, res) => {
    const { file } = req.body || {};
    if (!PROJECT_ROOT || !file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const errors = analyzer.validateWithPythonAST(file, PROJECT_ROOT);
        res.json({ success: true, errors });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/go-symbols', (req, res) => {
    const { file } = req.body || {};
    if (!PROJECT_ROOT || !file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const symbols = analyzer.getGoSymbols(file, PROJECT_ROOT);
        res.json({ success: true, symbols });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/go-validate', (req, res) => {
    const { file } = req.body || {};
    if (!PROJECT_ROOT || !file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const errors = analyzer.validateWithGoVet(file, PROJECT_ROOT);
        res.json({ success: true, errors });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/index', (req, res) => {
    try {
        const idx = analyzer.indexProject(PROJECT_ROOT);
        const stats = {
            files: Object.keys(idx.files).length,
            totalFunctions: 0,
            totalClasses: 0,
            totalExports: 0
        };
        for (const f of Object.values(idx.files)) {
            stats.totalFunctions += f.functions.length;
            stats.totalClasses += f.classes.length;
            stats.totalExports += f.exports.length;
        }
        res.json({ success: true, stats, files: Object.keys(idx.files).slice(0, 100) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/analyzer/invalidate', (req, res) => {
    invalidateProjectCache();
    res.json({ success: true });
});

app.post('/api/analyzer/symbols', (req, res) => {
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    const idx = analyzer.indexProject(PROJECT_ROOT);
    const all = [];
    for (const [relPath, parsed] of Object.entries(idx.files || {})) {
        for (const exp of (parsed.exports || [])) {
            all.push({ name: exp, kind: 'export', file: relPath, line: 1 });
        }
        for (const fn of (parsed.functions || [])) {
            all.push({ name: fn.name, kind: 'function', file: relPath, line: 1, params: fn.params });
        }
        for (const cls of (parsed.classes || [])) {
            all.push({ name: cls, kind: 'class', file: relPath, line: 1 });
        }
        for (const vt of (parsed.variables || [])) {
            all.push({ name: vt, kind: 'variable', file: relPath, line: 1 });
        }
    }
    res.json({ success: true, symbols: all, stats: { files: Object.keys(idx.files || {}).length, total: all.length } });
});

app.post('/api/analyzer/definition', (req, res) => {
    const { file, symbol, wordUnderCursor } = req.body || {};
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    const idx = analyzer.indexProject(PROJECT_ROOT);
    const searchName = symbol || wordUnderCursor || '';
    if (!searchName) return res.json({ success: true, locations: [] });
    const results = [];
    for (const [relPath, parsed] of Object.entries(idx.files || {})) {
        if (parsed.exports && parsed.exports.includes(searchName)) {
            results.push({ file: relPath, line: 1, name: searchName, kind: 'export' });
        }
        for (const fn of (parsed.functions || [])) {
            if (fn.name === searchName) {
                results.push({ file: relPath, line: 1, name: searchName, kind: 'function' });
            }
        }
        for (const cls of (parsed.classes || [])) {
            if (cls === searchName) {
                results.push({ file: relPath, line: 1, name: searchName, kind: 'class' });
            }
        }
    }
    res.json({ success: true, locations: results });
});

app.post('/api/analyzer/references', (req, res) => {
    const { file, symbol, wordUnderCursor } = req.body || {};
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    const searchName = symbol || wordUnderCursor || '';
    if (!searchName) return res.json({ success: true, locations: [] });
    const results = [];
    const idx = analyzer.indexProject(PROJECT_ROOT);
    for (const [relPath, parsed] of Object.entries(idx.files || {})) {
        for (const imp of (parsed.imports || [])) {
            if (imp.name === searchName) {
                results.push({ file: relPath, line: 1, name: searchName, kind: 'import' });
            }
        }
        for (const fn of (parsed.functions || [])) {
            if (fn.name === searchName) {
                results.push({ file: relPath, line: 1, name: searchName, kind: 'function' });
            }
        }
    }
    try {
        const relFile = file || '';
        if (relFile) {
            const fullPath = resolveSafePath(relFile);
            if (fullPath && fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const escapedName = searchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const refRegex = new RegExp(String.raw`\b${escapedName}\b`);
                const lines = content.split('\n');
                lines.forEach((line, idxLine) => {
                    if (refRegex.test(line)) {
                        results.push({ file: relFile, line: idxLine + 1, name: searchName, kind: 'reference' });
                    }
                });
            }
        }
    } catch (e) {}
    res.json({ success: true, locations: results });
});

app.post('/api/analyzer/completions', (req, res) => {
    const { prefix, file } = req.body || {};
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    const searchPrefix = (prefix || '').toLowerCase();
    const idx = analyzer.indexProject(PROJECT_ROOT);
    const items = [];
    const seen = new Set();
    for (const [relPath, parsed] of Object.entries(idx.files || {})) {
        for (const exp of (parsed.exports || [])) {
            if (exp.toLowerCase().startsWith(searchPrefix) && !seen.has(exp)) {
                seen.add(exp);
                items.push({ label: exp, kind: 'property', detail: 'export de ' + relPath, insertText: exp });
            }
        }
        for (const fn of (parsed.functions || [])) {
            if (fn.name.toLowerCase().startsWith(searchPrefix) && !seen.has(fn.name)) {
                seen.add(fn.name);
                items.push({
                    label: fn.name, kind: 'function', detail: '(' + (fn.params || []).join(', ') + ')',
                    insertText: fn.name + '($0)', insertTextRules: 4
                });
            }
        }
        for (const cls of (parsed.classes || [])) {
            if (cls.toLowerCase().startsWith(searchPrefix) && !seen.has(cls)) {
                seen.add(cls);
                items.push({ label: cls, kind: 'class', detail: 'classe em ' + relPath, insertText: cls });
            }
        }
        for (const vt of (parsed.variables || [])) {
            if (vt.toLowerCase().startsWith(searchPrefix) && !seen.has(vt)) {
                seen.add(vt);
                items.push({ label: vt, kind: 'variable', detail: 'var em ' + relPath, insertText: vt });
            }
        }
    }
    res.json({ success: true, completions: items });
});

// ===== AI INLINE COMPLETION (PRIORIDADE 2) =====
app.post('/api/ai/inline-completion', async (req, res) => {
    const { prefix, suffix, filePath, provider, language } = req.body || {};
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    if (!prefix || prefix.length < 2) return res.json({ completion: '' });

    const prefixSnip = prefix.length > 2000 ? prefix.slice(-2000) : prefix;
    const suffixSnip = (suffix || '').slice(0, 500);
    let fileCtx = '';
    if (filePath) {
        try {
            const relFiles = getRelFilePaths(filePath);
            fileCtx = relFiles.map(f => `// ${f}\n`).join('').slice(0, 3000);
        } catch (e) {}
    }

    const prompt = `Complete o código a seguir. Retorne APENAS a continuação (1 a 5 linhas), sem repetir o código antes do cursor. Se for completar um bloco (if, for, function), complete o bloco inteiro. Nada de explicações, markdown ou código extra.

ARQUIVO ATUAL: ${filePath || 'desconhecido'}
LINGUAGEM: ${language || 'plaintext'}
ARQUIVOS NO PROJETO:
${fileCtx || '(não disponível)'}

CÓDIGO ANTES DO CURSOR:
\`\`\`${language || ''}
${prefixSnip}
\`\`\`

CÓDIGO DEPOIS DO CURSOR:
\`\`\`${language || ''}
${suffixSnip}
\`\`\`

Complete o código após o cursor. Apenas a continuação:`;

    try {
        const completion = await callAI(provider || 'gemini', prompt, null, null);
        const clean = (completion || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/^\s*[\r\n]+/, '')
            .trim();
        const lines = clean.split('\n').slice(0, 5);
        const multiLine = lines.join('\n');
        res.json({ completion: multiLine.slice(0, 2000) });
    } catch (e) {
        res.json({ completion: '' });
    }
});

// ===== AI INLINE EDIT (Ctrl+K) =====
app.post('/api/ai/inline-edit', async (req, res) => {
    const { code, prompt, filePath, language, provider } = req.body || {};
    if (!PROJECT_ROOT) return res.status(400).json({ error: 'Nenhum projeto aberto' });
    if (!code || !prompt) return res.status(400).json({ error: 'Código e prompt são obrigatórios' });

    const aiPrompt = `Edite o seguinte código conforme solicitado. Retorne APENAS o código editado, completo. Nada de explicações, markdown ou código extra.

ARQUIVO: ${filePath || 'desconhecido'}
LINGUAGEM: ${language || 'plaintext'}

SOLICITAÇÃO: ${prompt}

CÓDIGO ORIGINAL:
\`\`\`${language || ''}
${code.slice(0, 6000)}
\`\`\`

Código editado:`;

    try {
        const response = await callAI(provider || 'gemini', aiPrompt, null, null);
        const clean = (response || '')
            .replace(/```[\w]*\n?/g, '')
            .replace(/```/g, '')
            .trim();
        res.json({ code: clean || code });
    } catch (e) {
        res.json({ code: code });
    }
});

function getRelFilePaths(currentFile) {
    const curDir = currentFile ? path.dirname(currentFile) : '';
    const items = [];
    try {
        const allFiles = getAllFiles(PROJECT_ROOT, { n: 30 });
        for (const f of allFiles) {
            const rel = path.relative(PROJECT_ROOT, f).replace(/\\/g, '/');
            items.push(rel);
        }
    } catch (e) {}
    return items;
}

// ===== UPLOAD DE ARQUIVO (drag & drop) =====
app.post('/api/file/upload', (req, res) => {
    const { name, content, encoding, targetDir } = req.body || {};
    if (!name || !content) return res.status(400).json({ error: 'Nome e conteúdo são obrigatórios' });
    const dir = targetDir || '';
    const relPath = dir ? dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + name : name;
    const fullPath = resolveSafePath(relPath);
    if (!fullPath) return res.status(400).json({ error: 'Caminho fora do projeto' });
    try {
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        if (encoding === 'base64') {
            fs.writeFileSync(fullPath, Buffer.from(content, 'base64'));
        } else {
            fs.writeFileSync(fullPath, content, 'utf-8');
        }
        res.json({ success: true, path: relPath });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/file/stat', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath) return res.status(400).json({ error: 'Caminho não especificado' });
    const fullPath = resolveSafePath(filePath);
    if (!fullPath) return res.status(400).json({ error: 'Caminho fora do projeto' });
    try {
        const stat = fs.statSync(fullPath);
        res.json({ success: true, isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
    } catch (e) {
        res.status(404).json({ success: false, error: 'Arquivo não encontrado' });
    }
});

// ===== DEBUGGER (CDP - passo a passo) =====
function broadcastDebug(type, payload) {
    const msg = JSON.stringify({ type, ...payload });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch (e) {}
        }
    }
}

const DEBUG_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);

app.post('/api/debug/start', async (req, res) => {
    const { path: filePath, breakpoints } = req.body || {};
    if (!filePath) {
        return res.status(400).json({ error: 'Arquivo não especificado' });
    }
    const fullPath = resolveSafePath(filePath);
    if (!fullPath) {
        return res.status(400).json({ error: 'Caminho fora do projeto' });
    }
    const ext = path.extname(fullPath).toLowerCase();
    if (!DEBUG_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: `Depuração suportada apenas para: ${[...DEBUG_EXTENSIONS].join(', ')}` });
    }
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    if (debuggerRunner.isRunning()) {
        return res.status(409).json({ error: 'Já existe uma sessão de debug em andamento' });
    }

    const onEvent = (ev) => broadcastDebug(ev.type, ev);
    try {
        await debuggerRunner.startDebug({
            file: fullPath,
            breakpoints,
            onEvent
        });
        broadcastDebug('debug-started', { file: filePath });
        res.json({ success: true, file: filePath });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, error: e.message });
    }
});

app.post('/api/debug/chrome', async (req, res) => {
    if (debuggerRunner.isRunning()) return res.status(409).json({ error: 'Já existe uma sessão de debug em andamento' });
    const { url } = req.body || {};
    try {
        await debuggerRunner.startChromeDebug({ url: url || 'about:blank', onEvent: (ev) => broadcastDebug(ev.type, ev) });
        broadcastDebug('debug-started', { type: 'chrome' });
        res.json({ success: true, type: 'chrome' });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, error: e.message });
    }
});

app.post('/api/debug/python', async (req, res) => {
    const { file, breakpoints } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });
    const fullPath = resolveSafePath(file);
    if (!fullPath) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
    if (debuggerRunner.isRunning()) return res.status(409).json({ error: 'Já existe uma sessão de debug em andamento' });
    try {
        await debuggerRunner.startPythonDebug({ file: fullPath, breakpoints, onEvent: (ev) => broadcastDebug(ev.type, ev) });
        broadcastDebug('debug-started', { file, type: 'python' });
        res.json({ success: true, file, type: 'python' });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, error: e.message });
    }
});

app.post('/api/debug/go', async (req, res) => {
    const { file, breakpoints } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });
    const fullPath = resolveSafePath(file);
    if (!fullPath) return res.status(400).json({ error: 'Caminho fora do projeto' });
    const cwd = path.dirname(fullPath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
    if (debuggerRunner.isRunning()) return res.status(409).json({ error: 'Já existe uma sessão de debug em andamento' });
    try {
        await debuggerRunner.startGoDebug({ file: fullPath, cwd, breakpoints, onEvent: (ev) => broadcastDebug(ev.type, ev) });
        broadcastDebug('debug-started', { file, type: 'go' });
        res.json({ success: true, file, type: 'go' });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, error: e.message });
    }
});

app.post('/api/debug/resume', async (req, res) => {
    try { res.json(await debuggerRunner.resume()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/debug/step', async (req, res) => {
    try { res.json(await debuggerRunner.stepOver()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/debug/stepInto', async (req, res) => {
    try { res.json(await debuggerRunner.stepInto()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/debug/stepOut', async (req, res) => {
    try { res.json(await debuggerRunner.stepOut()); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/debug/stop', (req, res) => {
    try {
        const r = debuggerRunner.stopDebug();
        broadcastDebug('debug-ended', { code: -1 });
        res.json(r);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== DEBUGGER: AVALIAR EXPRESSÃO =====
app.post('/api/debug/evaluate', async (req, res) => {
    if (!debuggerRunner.isRunning()) {
        return res.status(400).json({ success: false, error: 'Depurador não está em execução' });
    }
    const { expression } = req.body;
    if (!expression) return res.status(400).json({ success: false, error: 'Expressão vazia' });
    try {
        const result = await debuggerRunner.evaluate(expression);
        res.json({ success: true, value: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== BUSCA NO PROJETO =====
function isBinaryExtension(name) {
    const bin = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'exe', 'dll', 'msi', 'mp3', 'mp4', 'woff', 'woff2', 'ttf', 'otf', 'node']);
    const ext = (name.split('.').pop() || '').toLowerCase();
    return bin.has(ext);
}

app.post('/api/search', (req, res) => {
    const { query, inContent, caseSensitive, useRegex } = req.body;
    const q = String(query || '').trim();
    if (!q) return res.status(400).json({ error: 'Busca vazia' });

    let testFn;
    try {
        if (useRegex) {
            const flags = caseSensitive ? 'g' : 'gi';
            const re = new RegExp(q, flags);
            testFn = (str) => re.test(str);
        } else if (caseSensitive) {
            testFn = (str) => str.includes(q);
        } else {
            const lower = q.toLowerCase();
            testFn = (str) => str.toLowerCase().includes(lower);
        }
    } catch (e) {
        return res.status(400).json({ error: 'Regex inválida: ' + e.message });
    }

    const results = [];
    const count = { n: 0 };

    const walk = (dir, rel) => {
        if (count.n >= MAX_CONTEXT_FILES) return;
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (count.n >= MAX_CONTEXT_FILES) return;
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            count.n++;
            const nameMatch = testFn(entry.name);
            let matches = [];

            if (inContent) {
                const full = path.join(dir, entry.name);
                try {
                    if (fs.statSync(full).size <= 2 * 1024 * 1024 && !isBinaryExtension(entry.name)) {
                        const content = fs.readFileSync(full, 'utf-8');
                        if (!content.includes('\u0000')) {
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length && matches.length < 20; i++) {
                                if (testFn(lines[i])) {
                                    matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
                                }
                            }
                        }
                    }
                } catch (e) {}
            }

            if (nameMatch || matches.length > 0) {
                results.push({ path: relPath, name: entry.name, matches });
            }
        }
    };

    walk(PROJECT_ROOT, '');
    res.json({ success: true, results: results.slice(0, 100) });
});

// ===== BUSCA E SUBSTITUIÇÃO EM MÚLTIPLOS ARQUIVOS =====
app.post('/api/replace', (req, res) => {
    const { search, replace, caseSensitive, useRegex } = req.body;
    const q = String(search || '');
    if (!q) return res.status(400).json({ error: 'Busca vazia' });
    
    const results = [];
    const count = { n: 0 };
    const affectedFiles = [];
    
    let searchPattern;
    try {
        if (useRegex) {
            const flags = caseSensitive ? 'g' : 'gi';
            searchPattern = new RegExp(q, flags);
        } else {
            searchPattern = caseSensitive ? q : q.toLowerCase();
        }
} catch (e) {
        return res.status(400).json({ error: 'Regex inválida: ' + e.message });
    }

    const walk = (dir, rel) => {
        if (count.n >= MAX_CONTEXT_FILES) return;
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (count.n >= MAX_CONTEXT_FILES) return;
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            count.n++;
            if (isBinaryExtension(entry.name)) return;
            
            const full = path.join(dir, entry.name);
            try {
                if (fs.statSync(full).size > 2 * 1024 * 1024) return;
                const content = fs.readFileSync(full, 'utf-8');
                if (content.includes('\u0000')) return;
                
                const lines = content.split('\n');
                const matches = [];
                for (let i = 0; i < lines.length; i++) {
                    const matches_ = useRegex 
                        ? (lines[i].match(searchPattern) || [])
                        : (caseSensitive ? lines[i].split(q).length - 1 : lines[i].toLowerCase().split(q).length - 1);
                    const hitCount = Array.isArray(matches_) ? matches_.length : matches_;
                    if (hitCount > 0 && matches.length < 20) {
                        matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200), count: hitCount });
                    }
                }
                
                if (matches.length > 0) {
                    results.push({ 
                        path: relPath, 
                        name: entry.name, 
                        matches,
                        totalMatches: matches.reduce((s, m) => s + m.count, 0)
                    });
                    affectedFiles.push({ path: relPath, fullPath: full });
                }
            } catch (e) {}
        }
    };
    
    walk(PROJECT_ROOT, '');
    
    // If replace provided, execute replacement
    if (replace !== undefined && replace !== null) {
        let totalReplaced = 0;
        for (const file of affectedFiles) {
            try {
                const content = fs.readFileSync(file.fullPath, 'utf-8');
                let newContent;
                if (useRegex) {
                    newContent = content.replace(searchPattern, replace);
                } else if (caseSensitive) {
                    newContent = content.split(q).join(replace);
                } else {
                    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    newContent = content.replace(new RegExp(escaped, 'gi'), replace);
                }
                if (newContent !== content) {
                    backupRelativePath(file.path);
                    fs.writeFileSync(file.fullPath, newContent, 'utf-8');
                    const replaced = useRegex ? (content.match(searchPattern) || []).length : 
                        (caseSensitive ? (content.split(q).length - 1) : (content.toLowerCase().split(q.toLowerCase()).length - 1));
                    totalReplaced += replaced;
                }
            } catch (e) {}
        }
        res.json({ success: true, results: results.slice(0, 100), replaced: totalReplaced, filesAffected: affectedFiles.length });
    } else {
        res.json({ success: true, results: results.slice(0, 100) });
    }
});

// ===== PREVIEW DA SUBSTITUIÇÃO (DIFF ANTES DE APLICAR) =====
app.post('/api/replace/preview', (req, res) => {
    const { search, replace, caseSensitive, useRegex } = req.body;
    const q = String(search || '');
    if (!q) return res.status(400).json({ error: 'Busca vazia' });

    let searchPattern;
    try {
        if (useRegex) {
            const flags = caseSensitive ? 'g' : 'gi';
            searchPattern = new RegExp(q, flags);
        } else {
            searchPattern = caseSensitive ? q : q.toLowerCase();
        }
    } catch (e) {
        return res.status(400).json({ error: 'Regex inválida: ' + e.message });
    }

    const results = [];
    const count = { n: 0 };

    const walk = (dir, rel) => {
        if (count.n >= MAX_CONTEXT_FILES) return;
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (count.n >= MAX_CONTEXT_FILES) return;
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            count.n++;
            if (isBinaryExtension(entry.name)) return;

            const full = path.join(dir, entry.name);
            try {
                if (fs.statSync(full).size > 2 * 1024 * 1024) return;
                const content = fs.readFileSync(full, 'utf-8');
                if (content.includes('\u0000')) return;

                let newContent;
                let changeCount = 0;
                if (useRegex) {
                    const matches = content.match(searchPattern);
                    changeCount = matches ? matches.length : 0;
                    newContent = content.replace(searchPattern, replace || '');
                } else if (caseSensitive) {
                    changeCount = content.split(q).length - 1;
                    newContent = content.split(q).join(replace || '');
                } else {
                    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(escaped, 'gi');
                    const matches = content.match(re);
                    changeCount = matches ? matches.length : 0;
                    newContent = content.replace(re, replace || '');
                }

                if (changeCount > 0) {
                    var previewLines = [];
                    var oldLines = content.split('\n');
                    var newLines = newContent.split('\n');
                    var maxLine = Math.min(Math.max(oldLines.length, newLines.length), 80);
                    for (var i = 0; i < maxLine; i++) {
                        var ol = oldLines[i] || '';
                        var nl = newLines[i] || '';
                        if (ol !== nl) {
                            if (ol) previewLines.push('- ' + ol.slice(0, 120));
                            if (nl) previewLines.push('+ ' + nl.slice(0, 120));
                        }
                    }
                    var preview = previewLines.slice(0, 60).join('\n');

                    results.push({
                        file: relPath,
                        changes: changeCount,
                        preview: preview
                    });
                }
            } catch (e) {}
        }
    };

    walk(PROJECT_ROOT, '');
    res.json({ success: true, results: results.slice(0, 50) });
});

// ===== VALIDAÇÃO EM LOTE (pós-execução da IA) =====
app.post('/api/analyzer/validate-batch', (req, res) => {
    const { files } = req.body || {};
    if (!Array.isArray(files) || !files.length) return res.json({ success: true, errors: [] });
    const allErrors = [];
    for (const filePath of files) {
        const fullPath = resolveSafePath(filePath);
        if (!fullPath || !fs.existsSync(fullPath)) continue;
        try {
            const code = fs.readFileSync(fullPath, 'utf-8');
            const ext = (path.extname(filePath) || '.js').toLowerCase();
            let errors = [];
            if (['.ts', '.tsx'].includes(ext)) {
                errors = analyzer.validateWithTSProgram(filePath, PROJECT_ROOT);
            } else if (['.py', '.pyw'].includes(ext)) {
                errors = analyzer.validateWithPythonAST(filePath, PROJECT_ROOT);
            } else if (['.go'].includes(ext)) {
                errors = analyzer.validateWithGoVet(filePath, PROJECT_ROOT);
            } else if (['.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hh'].includes(ext)) {
                errors = analyzer.validateWithGCC(filePath, PROJECT_ROOT);
            } else if (ext === '.rs') {
                errors = analyzer.validateWithRustc(filePath, PROJECT_ROOT);
            }
            if (!errors.length) {
                const result = analyzer.validateCode(code, filePath, PROJECT_ROOT);
                errors = result.errors;
            }
            for (const e of errors) {
                allErrors.push({ file: filePath, line: e.line, column: e.column, message: e.message, severity: e.severity || 'error', type: e.type || 'syntax' });
            }
        } catch (e) {}
    }
    res.json({ success: true, errors: allErrors });
});

async function runPostExecutionDiagnostics(affectedFiles, planResumo) {
    if (!PROJECT_ROOT || !Array.isArray(affectedFiles) || !affectedFiles.length) return;

    // Garantia de término: os pós-testes (npm test, git commit) não podem
    // segurar o 'done' para sempre. Se passarem do prazo, a tarefa termina
    // mesmo assim e a UI nunca fica presa em "Enviando.../Executando".
    try {
        return await Promise.race([
            _runPostExecutionDiagnostics(affectedFiles, planResumo),
            new Promise((resolve) => setTimeout(() => {
                console.warn('[diagnostics] Pós-execução excedeu 150s — finalizando tarefa sem resultado');
                resolve({ timedOut: true, rolledBack: false, errorCount: 0 });
            }, 150000))
        ]);
    } catch (e) {
        return null;
    }
}

async function _runPostExecutionDiagnostics(affectedFiles, planResumo) {
    pushUndoState(affectedFiles);
    const allErrors = [];
    const allSmells = [];
    const allSecurity = [];
    const allLint = [];
    for (const filePath of affectedFiles) {
        const fullPath = resolveSafePath(filePath);
        if (!fullPath || !fs.existsSync(fullPath)) continue;
        try {
            const code = fs.readFileSync(fullPath, 'utf-8');
            const ext = (path.extname(filePath) || '.js').toLowerCase();

            const result = analyzer.validateCode(code, filePath, PROJECT_ROOT);
            for (const e of result.errors || []) {
                allErrors.push({ file: filePath, line: e.line, column: e.column, message: e.message, severity: e.severity || 'error', type: e.type || 'syntax' });
            }

            const smells = analyzer.detectCodeSmellsEnhanced(filePath, PROJECT_ROOT);
            for (const s of smells) {
                allSmells.push({ file: filePath, line: s.line, column: s.column || 1, message: s.message, severity: s.severity || 'warning', type: s.type || 'smell' });
            }

            const securityErrors = analyzer.scanSecurity(filePath, PROJECT_ROOT);
            for (const se of securityErrors) {
                allSecurity.push({ file: filePath, line: se.line, column: se.column, message: se.message, severity: se.severity || 'warning', type: 'security' });
            }

            const lintErrors = analyzer.runLinter(filePath, PROJECT_ROOT);
            for (const le of lintErrors) {
                allLint.push({ file: filePath, line: le.line, column: le.column, message: le.message, severity: le.severity || 'warning', type: le.type || 'linter' });
            }
        } catch (e) {}
    }

    const combined = [...allErrors, ...allSmells, ...allSecurity, ...allLint];
    if (combined.length) {
        broadcastDiagnostics(combined);
        const errCount = allErrors.filter(e => e.severity === 'error').length;
        const warnCount = allSmells.length + allSecurity.length + allLint.length;
        if (errCount > 0) {
            broadcastAll({ type: 'diagnostics-summary', errorCount: errCount, warningCount: warnCount, message: `${errCount} erro(s), ${warnCount} aviso(s) em ${affectedFiles.length} arquivo(s)` });
        }
    }
    const errorCount = allErrors.filter(e => e.severity === 'error').length;

    try {
        const detectedFramework = detectTestFramework();
        const testFiles = [];
        const walkTests = (dir, rel) => {
            let items;
            try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const entry of items) {
                if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) walkTests(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name); continue; }
                const name = entry.name;
                if (name.match(/\.(test|spec)\.(js|ts|tsx|mjs|cjs|py|go|rs|java|rb|php|kt|swift|dart|scala|ex|exs)$/) || (rel && rel.includes('__tests__'))) {
                    testFiles.push(rel ? `${rel}/${name}` : name);
                }
            }
        };
        walkTests(PROJECT_ROOT, '');
        if (testFiles.length && detectedFramework) {
            const { command, args } = detectedFramework;
            broadcastAll({ type: 'test-status', status: 'running', message: '[' + command + '] ' + testFiles.length + ' teste(s)...' });
            // Timeout de 120s: testes que nunca terminam (ex.: Jest com watch mode ou
            // processo pendurado) não podem travar a UI em "Enviando..." para sempre.
            const TEST_RUN_TIMEOUT_MS = 120000;
            const result = await new Promise((resolve) => {
                const child = require('child_process').spawn(command, args, { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
                registerChildProcess(child);
                let output = '';
                let settled = false;
                let spawnError = null;
                const startTs = Date.now();
                const finish = (r) => {
                    if (settled) return;
                    settled = true;
                    if (progressTimer) clearInterval(progressTimer);
                    resolve(r);
                };
                // Mantém a UI informada (e o watchdog do frontend vivo) durante testes
                // longos: sem isso, uma suíte legítima de 60-120s pareceria "travada".
                const progressTimer = setInterval(() => {
                    if (settled) return;
                    const secs = Math.round((Date.now() - startTs) / 1000);
                    broadcastAll({ type: 'test-status', status: 'running', message: `[${command}] Executando testes... (${secs}s)` });
                }, 20000);
                child.stdout.on('data', d => output += d.toString());
                child.stderr.on('data', d => output += d.toString());
                child.on('close', code => {
                    const parsed = parseTestOutput(output);
                    const empty = parsed.total === 0;
                    // Comando nem chegou a rodar (ex.: "npm" não encontrado).
                    if (spawnError) {
                        finish({ errored: true, errorMessage: String(spawnError.message || 'Falha ao iniciar o comando de teste'), passed: 0, failed: 0, total: 0, output: output.slice(0, 3000), results: parsed });
                        return;
                    }
                    // Rodou mas falhou sem executar nenhum teste (ex.: npx tentou
                    // instalar o Jest, erro de config, "No tests found" com exit != 0).
                    if (code !== 0 && empty) {
                        const reason = /no tests found/i.test(output) ? 'Nenhum teste encontrado' : 'O comando de teste falhou';
                        finish({ errored: true, errorMessage: reason, passed: 0, failed: 0, total: 0, output: output.slice(0, 3000), results: parsed });
                        return;
                    }
                    finish({ passed: parsed.pass, failed: parsed.fail, total: parsed.total, output: output.slice(0, 3000), results: parsed });
                });
                child.on('error', (err) => {
                    spawnError = err;
                    // 'error' pode disparar sem 'close' em alguns casos — finaliza aqui.
                    finish({ errored: true, errorMessage: String(err.message || 'Falha ao iniciar o comando de teste'), passed: 0, failed: 0, total: 0, output: '', results: { total: 0, pass: 0, fail: 0, details: [], suites: [] } });
                });
                const killer = setTimeout(() => {
                    killChildTree(child);
                    finish({ errored: true, errorMessage: 'Testes excederam o tempo limite de 120s e foram interrompidos', passed: 0, failed: 0, total: 0, output: 'Testes excederam o tempo limite de 120s', results: { total: 0, pass: 0, fail: 0, details: [], suites: [] } });
                }, TEST_RUN_TIMEOUT_MS);
                child.on('close', () => clearTimeout(killer));
            });

            // Falha de infraestrutura (comando não rodou): reporta claramente,
            // mas NÃO reverte as alterações — o problema é do ambiente, não do código.
            if (result.errored) {
                const errMsg = result.errorMessage || 'Falha ao executar testes';
                const errOutput = result.output || errMsg;
                broadcastAll({ type: 'test-status', status: 'failed', message: '❌ ' + errMsg, results: { total: 0, pass: 0, fail: 0, details: [], suites: [] } });
                broadcastAll({ type: 'test-failed', message: '❌ ' + errMsg + '\n' + String(errOutput).slice(0, 2000) });
                return { rolledBack: false, errorCount, testError: errMsg };
            }

            const testMsg = '[' + command + '] Passaram: ' + result.passed + (result.failed ? ', Falharam: ' + result.failed : '') + ' (' + result.total + ' total)';
            broadcastAll({ type: 'test-status', status: result.failed ? 'failed' : 'passed', message: testMsg, results: result.results });

            if (result.failed > 0) {
                broadcastAll({ type: 'test-failed', message: result.output });
                const restored = restoreProjectSnapshot();
                const restoredCount = restored.count;
                broadcastAll({ type: 'refresh' });
                return { rolledBack: true, testsFailed: true, testDetails: result, restoredCount };
            }
        }
    } catch (e) {}

    try {
        if (planResumo && config.autoCommit) {
            const commitMsg = 'feat(ia): ' + (planResumo.length > 72 ? planResumo.slice(0, 72) + '...' : planResumo);
            const filesToStage = (affectedFiles && affectedFiles.length)
                ? affectedFiles.filter(f => typeof f === 'string').map(f => f.replace(/\\/g, '/'))
                : [];
            const runGit = (args) => new Promise((resolve) => {
                // GIT_TERMINAL_PROMPT=0 impede o git de ficar esperando credenciais
                // interativas para sempre (travaria a tarefa em "Enviando...").
                const child = require('child_process').spawn('git', args, { cwd: PROJECT_ROOT, stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
                let settled = false;
                let killer;
                const finish = () => { if (settled) return; settled = true; if (killer) clearTimeout(killer); resolve(); };
                killer = setTimeout(() => { killChildTree(child); finish(); }, 60000);
                child.on('close', finish);
                child.on('error', finish);
            });
            if (filesToStage.length > 0) {
                await runGit(['add', ...filesToStage]);
                await runGit(['commit', '-m', commitMsg]);
            } else {
                await runGit(['commit', '-am', commitMsg]);
            }
            broadcastAll({ type: 'auto-commit', message: 'Commit automatico: ' + commitMsg });
        }
    } catch (e) {}

    return { rolledBack: false, errorCount };
}

function broadcastDiagnostics(errors) {
    broadcastAll({ type: 'diagnostics', errors });
}

function broadcastAll(payload) {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(data); } catch (e) {}
        }
    }
}

// ===== AUTO-DETECÇÃO DE TEST FRAMEWORK =====
function detectTestFramework() {
    if (!PROJECT_ROOT) return null;
    try {
        const pkgPath = path.join(PROJECT_ROOT, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            // Prefere o script "test" do projeto: respeita a configuração real
            // (ex.: "test": "jest") e garante que o Jest esteja instalado via npm.
            if (pkg.scripts && pkg.scripts.test) return { command: 'npm', args: ['test'] };
            if (pkg.devDependencies || pkg.dependencies) {
                const deps = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) };
                if (deps.jest) return { command: 'npx', args: ['jest', '--passWithNoTests'] };
                if (deps.mocha) return { command: 'npx', args: ['mocha', '**/*.test.js', '**/*.spec.js', '--exit'] };
                if (deps.vitest) return { command: 'npx', args: ['vitest', 'run', '--passWithNoTests'] };
            }
        }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'pom.xml')) || fs.existsSync(path.join(PROJECT_ROOT, 'build.gradle'))) {
            if (fs.existsSync(path.join(PROJECT_ROOT, 'mvnw'))) return { command: 'mvnw', args: ['test'] };
            if (fs.existsSync(path.join(PROJECT_ROOT, 'gradlew'))) return { command: 'gradlew', args: ['test'] };
            return { command: 'mvn', args: ['test', '-q'] };
        }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'Gemfile'))) return { command: 'bundle', args: ['exec', 'rspec'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'composer.json'))) return { command: 'php', args: ['vendor/bin/phpunit'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'mix.exs'))) return { command: 'mix', args: ['test'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'go.mod'))) return { command: 'go', args: ['test', './...'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'Cargo.toml'))) return { command: 'cargo', args: ['test'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'build.sbt'))) return { command: 'sbt', args: ['test'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'Makefile'))) {
            const mk = fs.readFileSync(path.join(PROJECT_ROOT, 'Makefile'), 'utf-8');
            if (/^test\s*:/m.test(mk)) return { command: 'make', args: ['test'] };
        }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'pyproject.toml')) || fs.existsSync(path.join(PROJECT_ROOT, 'setup.py'))) {
            return { command: 'python', args: ['-m', 'pytest', '-x'] };
        }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'pubspec.yaml'))) return { command: 'dart', args: ['test'] };
        if (fs.existsSync(path.join(PROJECT_ROOT, 'stack.yaml')) || fs.existsSync(path.join(PROJECT_ROOT, 'package.yaml'))) {
            return { command: 'stack', args: ['test'] };
        }
        return { command: 'node', args: ['--test'] };
    } catch (e) { return { command: 'node', args: ['--test'] }; }
}

// ===== TASK RUNNER MULTI-LINGUAGEM =====
function detectBuildCommands() {
    const commands = [];
    if (!PROJECT_ROOT) return commands;
    try {
        const pkgPath = path.join(PROJECT_ROOT, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            if (pkg.scripts) {
                if (pkg.scripts.build) commands.push({ label: 'npm build', command: 'npm', args: ['run', 'build'] });
                if (pkg.scripts.dev) commands.push({ label: 'npm dev', command: 'npm', args: ['run', 'dev'] });
                if (pkg.scripts.lint) commands.push({ label: 'npm lint', command: 'npm', args: ['run', 'lint'] });
            }
        }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'Makefile'))) { commands.push({ label: 'make', command: 'make', args: [] }); }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'go.mod'))) { commands.push({ label: 'go build', command: 'go', args: ['build', './...'] }); }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'Cargo.toml'))) { commands.push({ label: 'cargo build', command: 'cargo', args: ['build'] }); }
        if (fs.existsSync(path.join(PROJECT_ROOT, 'pyproject.toml'))) { commands.push({ label: 'pip install', command: 'pip', args: ['install', '-e', '.'] }); }
    } catch (e) {}
    return commands;
}

// ===== ENDPOINT: PROJECT SUMMARY =====
app.post('/api/project/summary', (req, res) => {
    if (!PROJECT_ROOT) return res.json({ success: false, error: 'Nenhum projeto aberto' });
    try {
        const extCounts = {};
        let totalFiles = 0;
        const walk = (dir) => {
            let items;
            try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const entry of items) {
                if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name)); continue; }
                totalFiles++;
                const ext = path.extname(entry.name).toLowerCase();
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            }
        };
        walk(PROJECT_ROOT);
        const buildCommands = detectBuildCommands();
        const testFramework = detectTestFramework();
        const pkgPath = path.join(PROJECT_ROOT, 'package.json');
        let pkgName = '', pkgVersion = '';
        if (fs.existsSync(pkgPath)) {
            try { const p = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); pkgName = p.name || ''; pkgVersion = p.version || ''; } catch (e) {}
        }
        res.json({
            success: true,
            projectRoot: PROJECT_ROOT,
            name: pkgName || path.basename(PROJECT_ROOT),
            version: pkgVersion,
            totalFiles,
            languages: extCounts,
            buildCommands,
            testFramework: testFramework ? testFramework.command : null,
            timestamp: new Date().toISOString()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ENDPOINT: BUILD TASK =====
app.post('/api/project/build', async (req, res) => {
    const { command, args } = req.body || {};
    if (!command) return res.status(400).json({ error: 'Comando não especificado' });
    try {
        const result = await runner.runCommand({ command, args: args || [], cwd: PROJECT_ROOT, timeoutMs: 120000 });
        res.json({ success: true, output: result.stdout || result.stderr, code: result.code });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== FILE WATCHER (mudanças externas) =====
let fileWatcher = null;
function startFileWatcher() {
    if (!PROJECT_ROOT || fileWatcher) return;
    try {
        fileWatcher = fs.watch(PROJECT_ROOT, { recursive: true }, (eventType, filename) => {
            if (!filename || IGNORED_DIRS.has(filename.split(path.sep)[0])) return;
            if (filename.includes('.aedificator-codex-ide-backup')) return;
            broadcastAll({ type: 'file-changed', file: filename, event: eventType });
        });
        // unref(): o watcher continua funcionando enquanto o app roda, mas não
        // segura o processo vivo — senão o `npm test` trava após os testes.
        try { if (fileWatcher.unref) fileWatcher.unref(); } catch (e) {}
    } catch (e) {}
}

app.post('/api/file/image', (req, res) => {
    const { path: filePath } = req.body;
    const full = resolveSafePath(filePath);
    if (!full) return res.status(400).json({ error: 'Caminho fora do projeto' });
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    if (fs.statSync(full).size > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'Imagem grande demais (máx. 10MB)' });
    }
    try {
        const data = fs.readFileSync(full).toString('base64');
        const ext = path.extname(full).toLowerCase();
        const mime = ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.gif' ? 'image/gif'
            : ext === '.svg' ? 'image/svg+xml'
            : ext === '.webp' ? 'image/webp'
            : ext === '.bmp' ? 'image/bmp'
            : ext === '.ico' ? 'image/x-icon'
            : 'application/octet-stream';
        res.json({ success: true, dataUrl: `data:${mime};base64,${data}`, name: path.basename(full), path: filePath });
    } catch (e) {
        res.status(500).json({ error: 'Não foi possível ler a imagem' });
    }
});

// ===== FORMATAÇÃO DE CÓDIGO (Prettier) =====
function formatCode(language, code) {
    const prettierPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'prettier');
    const isWin = process.platform === 'win32';
    const bin = isWin ? prettierPath + '.cmd' : prettierPath;
    
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(bin)) {
            try {
                const formatted = basicFormat(language, code);
                resolve(formatted);
            } catch (e) {
                reject(new Error('Prettier não encontrado: ' + e.message));
            }
            return;
        }
        
        let parser = 'babel';
        if (language === 'typescript' || language === 'typescriptreact') parser = 'typescript';
        else if (language === 'json') parser = 'json';
        else if (language === 'css' || language === 'scss' || language === 'less') parser = 'css';
        else if (language === 'html') parser = 'html';
        else if (language === 'markdown') parser = 'markdown';
        else if (language === 'yaml') parser = 'yaml';
        
        const child = spawn(bin, ['--parser', parser, '--stdin-filepath', 'file.' + (language === 'typescript' ? 'ts' : language === 'json' ? 'json' : 'js')], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: PROJECT_ROOT
        });
        
        let out = '';
        let err = '';
        const timer = setTimeout(() => { try { child.kill(); } catch(e) {} }, 15000);
        
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); try { resolve(basicFormat(language, code)); } catch(x) { resolve(code); } });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && out.trim()) {
                resolve(out);
            } else {
                try { resolve(basicFormat(language, code)); } catch(e) { resolve(code); }
            }
        });
        child.stdin.write(code);
        child.stdin.end();
    });
}

function basicFormat(language, code) {
    const lines = code.split('\n');
    let formatted = '';
    let indentLevel = 0;
    const indent = '    ';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed) { formatted += '\n'; continue; }
        
        if (trimmed.startsWith('}') || trimmed.startsWith(')') || trimmed.startsWith(']')) {
            indentLevel = Math.max(0, indentLevel - 1);
        }
        
        formatted += indent.repeat(indentLevel) + trimmed + '\n';
        
        if (trimmed.endsWith('{') || trimmed.endsWith('(') || trimmed.endsWith('[')) {
            indentLevel++;
        }
    }
    return formatted.trimEnd() + '\n';
}

app.post('/api/file/format', async (req, res) => {
    const { path: filePath, content, language } = req.body;
    if (!filePath || typeof content !== 'string') {
        return res.status(400).json({ error: 'Parâmetros inválidos' });
    }
    try {
        const formatted = await formatCode(language || 'javascript', content);
        res.json({ success: true, content: formatted });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== GIT =====
function runGit(args, cwd) {
    return new Promise((resolve) => {
        const child = spawn('git', args, { cwd });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
        }, 60000);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, output: '❌ git não encontrado: ' + e.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, output: out || err, errOutput: err });
        });
    });
}

app.post('/api/git/status', async (req, res) => {
    try {
        const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], PROJECT_ROOT);
        const status = await runGit(['status', '--short'], PROJECT_ROOT);
        const output = (branch.code === 0 ? `🌿 Branch: ${branch.output.trim()}\n\n` : '') + (status.output || '(repositório limpo)');
        res.json({ success: true, isRepo: branch.code === 0, output });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/commit', async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Mensagem de commit vazia' });
    }
    try {
        const add = await runGit(['add', '-A'], PROJECT_ROOT);
        const commit = await runGit(['commit', '-m', message.trim()], PROJECT_ROOT);
        res.json({ success: true, addOutput: add.output, commitOutput: commit.output, code: commit.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/diff', async (req, res) => {
    const { file } = req.body || {};
    try {
        const args = ['diff', '--no-color', '--'];
        if (file) args.push(file);
        const diff = await runGit(args, PROJECT_ROOT);
        const staged = await runGit(['diff', '--cached', '--no-color', '--'], PROJECT_ROOT);
        const stat = await runGit(['diff', '--stat', '--no-color', '--'], PROJECT_ROOT);
        res.json({ success: true, output: diff.output, staged: staged.output, stat: stat.output });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/stage', async (req, res) => {
    const { file, all } = req.body || {};
    try {
        const args = all ? ['add', '-A'] : ['add', '--', file];
        const r = await runGit(args, PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output || r.errOutput, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/unstage', async (req, res) => {
    const { file } = req.body || {};
    try {
        const r = await runGit(['reset', 'HEAD', '--', file], PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output || r.errOutput, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/push', async (req, res) => {
    const { branch } = req.body || {};
    try {
        const current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], PROJECT_ROOT)).output.trim();
        const args = ['push', 'origin', branch || current];
        const r = await runGit(args, PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output || r.errOutput, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/pull', async (req, res) => {
    try {
        const r = await runGit(['pull'], PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output || r.errOutput, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/branches', async (req, res) => {
    try {
        const r = await runGit(['branch', '-a'], PROJECT_ROOT);
        const current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], PROJECT_ROOT)).output.trim();
        res.json({ success: true, output: r.output, current, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/checkout', async (req, res) => {
    const { branch } = req.body || {};
    if (!branch) return res.status(400).json({ error: 'Branch não especificada' });
    try {
        const r = await runGit(['checkout', branch], PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output || r.errOutput, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/log', async (req, res) => {
    try {
        const r = await runGit(['log', '--oneline', '-20'], PROJECT_ROOT);
        res.json({ success: true, output: r.output, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== GIT MERGE =====
app.post('/api/git/merge', async (req, res) => {
    const { branch } = req.body || {};
    if (!branch) return res.status(400).json({ error: 'Branch não especificada' });
    try {
        const r = await runGit(['merge', branch], PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output, error: r.stderr, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== GIT STASH =====
app.post('/api/git/stash', async (req, res) => {
    const { action, message } = req.body || {};
    try {
        const args = ['stash'];
        if (action === 'list') args.push('list');
        else if (action === 'pop') args.push('pop');
        else if (action === 'drop') {
            if (message) { args.push('drop', message); } else args.push('drop');
        } else if (action === 'apply') {
            if (message) { args.push('apply', message); } else args.push('apply');
        } else {
            if (message) { args.push('push', '-m', message); } else args.push('push');
        }
        const r = await runGit(args, PROJECT_ROOT);
        res.json({ success: r.code === 0, output: r.output, error: r.stderr, code: r.code });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================
//  TEST RUNNER
// =============================================
app.post('/api/test/discover', (req, res) => {
    const testPatterns = [/\.test\.(js|ts|jsx|tsx|mjs|cjs)$/i, /\.spec\.(js|ts|jsx|tsx|mjs|cjs)$/i, /__tests__\/.*\.(js|ts|jsx|tsx)$/i];
    const results = [];
    const walk = (dir, rel) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (entry.isDirectory()) {
                if (IGNORED_DIRS.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
            } else if (testPatterns.some(p => p.test(entry.name))) {
                results.push(rel ? `${rel}/${entry.name}` : entry.name);
            }
        }
    };
    walk(PROJECT_ROOT, '');
    res.json({ success: true, tests: results });
});

app.post('/api/test/run', async (req, res) => {
    const { command } = req.body || {};
    const cmdStr = command || 'node --test';
    const [cmd, ...args] = cmdStr.split(/\s+/);
    try {
        const proc = spawn(cmd, args, { cwd: PROJECT_ROOT, shell: true });
        let output = '';
        proc.stdout.on('data', (d) => { output += d.toString('utf8'); });
        proc.stderr.on('data', (d) => { output += d.toString('utf8'); });
        proc.on('close', (code) => {
            res.json({
                success: true,
                exitCode: code,
                output,
                results: parseTestOutput(output)
            });
        });
        proc.on('error', (err) => {
            res.json({ success: false, error: err.message });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

function parseTestOutput(output) {
    const results = { total: 0, pass: 0, fail: 0, details: [], suites: [] };
    const lines = output.split('\n');
    const suiteStack = [{ name: 'root', tests: [] }];

    for (const line of lines) {
        const trimmed = line.trim();

        const suiteStart = trimmed.match(/^▶\s+(.+)$/);
        if (suiteStart) {
            const newSuite = { name: suiteStart[1].trim(), tests: [] };
            suiteStack[suiteStack.length - 1].tests.push(newSuite);
            suiteStack.push(newSuite);
            continue;
        }

        const suiteEnd = trimmed.match(/^✔\s+.+\s+\(([\d.]+)ms\)$/);
        if (suiteEnd && suiteStack.length > 1) {
            suiteStack.pop();
            continue;
        }

        const passMatch = trimmed.match(/^([✔✓])\s+(.+?)(?:\s+\(([\d.]+)ms\))?$/);
        if (passMatch) {
            results.pass++;
            results.total++;
            const name = passMatch[2] || '';
            const duration = passMatch[3] || '';
            const entry = { name, status: 'pass', duration };
            results.details.push(entry);
            if (suiteStack.length > 1) {
                suiteStack[suiteStack.length - 1].tests.push(entry);
            }
            continue;
        }

        const failMatch = trimmed.match(/^([✖✘✗✕])\s+(.+?)(?:\s+\(([\d.]+)ms\))?$/);
        if (failMatch) {
            results.fail++;
            results.total++;
            const name = failMatch[2] || '';
            const duration = failMatch[3] || '';
            const entry = { name, status: 'fail', duration, error: '' };
            results.details.push(entry);
            if (suiteStack.length > 1) {
                suiteStack[suiteStack.length - 1].tests.push(entry);
            }
            continue;
        }

        const failHeaderMatch = trimmed.match(/^[✖✘✗]\s+failing tests/);
        if (failHeaderMatch) continue;

        const failNameMatch = trimmed.match(/^test\s+at\s+(.+?):(\d+):\d+$/);
        if (failNameMatch) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail') {
                last.file = failNameMatch[1];
                last.line = parseInt(failNameMatch[2]);
            }
            continue;
        }

        const errorMatch = trimmed.match(/^\s*\[(Error|TypeError|ReferenceError|SyntaxError|AssertionError)[:\]]/);
        if (errorMatch) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail' && !last.error) {
                last.error = trimmed;
                last.errorType = errorMatch[1];
            }
            continue;
        }

        if (trimmed.startsWith('{') || trimmed.startsWith('error:')) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail') {
                last.error = (last.error || '') + '\n' + trimmed;
            }
        }
    }

    // Fallback para formatos de resumo de frameworks comuns (Jest/Mocha/Vitest),
    // usados quando nenhum teste individual foi detectado pelas linhas ✔/✖.
    if (results.total === 0) {
        const jestLine = output.split('\n').find(l => /^\s*Tests:\s/i.test(l));
        if (jestLine) {
            const num = (re) => { const m = jestLine.match(re); return m ? (parseInt(m[1].replace(/,/g, ''), 10) || 0) : 0; };
            // "Tests: 32 passed, 32 total" | "Tests: 31 passed, 1 failed, 32 total"
            // "Tests: 1 failed, 31 passed, 32 total" | "Tests: 32 total"
            const passed = num(/([\d,]+)\s+passed/i);
            const failed = num(/([\d,]+)\s+failed/i);
            const total = num(/([\d,]+)\s+total/i);
            if (passed || failed) {
                results.pass = passed;
                results.fail = failed;
                results.total = total || (passed + failed);
            } else if (total) {
                // "Tests: 32 total" sem menção de falhas → assumimos que passaram.
                results.pass = total;
                results.total = total;
            }
        } else {
            const passM = output.match(/([\d,]+)\s+passing/);
            const failM = output.match(/([\d,]+)\s+failing/);
            if (passM || failM) {
                results.pass = passM ? (parseInt(passM[1].replace(/,/g, ''), 10) || 0) : 0;
                results.fail = failM ? (parseInt(failM[1].replace(/,/g, ''), 10) || 0) : 0;
                results.total = results.pass + results.fail;
            }
        }
    }

    results.suites = suiteStack[0].tests;
    return results;
}

app.post('/api/git/blame', async (req, res) => {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const fullPath = resolveSafePath(file);
        if (!fullPath) return res.status(400).json({ error: 'Caminho inválido' });
        const relPath = path.relative(PROJECT_ROOT, fullPath);
        const r = await runGit(['blame', '--date=short', '--', relPath], PROJECT_ROOT);
        if (r.code !== 0) return res.json({ success: true, lines: [] });
        const raw = r.output;
        const lineRegex = /^([0-9a-f]{8,})\s+\(([^)]+)\)\s+(.*)$/;
        const lines = raw.split('\n').filter(l => l.trim()).map(l => {
            const m = l.match(lineRegex);
            if (!m) return { line: -1, hash: '', author: '', date: '', content: l.trim() };
            const info = m[2].split(/\s+/);
            const date = info.length >= 3 ? info[info.length - 3] : '';
            const author = info.length >= 3 ? info.slice(0, info.length - 3).join(' ') : m[2];
            return {
                line: -1, hash: m[1], author, date,
                content: (m[3] || '').trim()
            };
        });
        lines.forEach((l, i) => { l.line = i + 1; });
        res.json({ success: true, lines });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/file/original', (req, res) => {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const fullPath = resolveSafePath(file);
        if (!fullPath) return res.status(400).json({ error: 'Caminho inválido' });
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
        const relPath = path.relative(PROJECT_ROOT, fullPath);
        runGit(['show', 'HEAD:' + relPath], PROJECT_ROOT).then(r => {
            res.json({
                success: true,
                original: r.code === 0 ? r.output : '',
                current: fs.readFileSync(fullPath, 'utf-8')
            });
        }).catch(() => {
            res.json({ success: true, original: '', current: fs.readFileSync(fullPath, 'utf-8') });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/file/diff-preview', (req, res) => {
    const { file, conteudo } = req.body || {};
    if (!file) return res.status(400).json({ error: 'Arquivo não especificado' });
    try {
        const fullPath = resolveSafePath(file);
        if (!fullPath) return res.status(400).json({ error: 'Caminho inválido' });
        const original = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
        res.json({ success: true, original, modified: typeof conteudo === 'string' ? conteudo : '' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =============================================
//  DETECÇÃO AUTOMÁTICA DE REPOSITÓRIO
//  (identifica GitHub/GitLab a partir do remote)
// =============================================
function parseRemoteUrl(url) {
    if (!url) return null;
    const u = String(url).trim();
    const stripGit = (r) => r.replace(/\.git$/, '').replace(/\/$/, '');
    // https://github.com/gitlab.com/…/owner/repo(.git)
    let m = u.match(/https?:\/\/(github|gitlab)\.com\/([^/\s]+?)(?:\/(.+?))?\/([^/\s]+)(?:\.git)?$/i);
    if (m) {
        let owner = m[3] ? `${m[2]}/${m[3]}` : m[2]; // grupos: owner é o namespace
        return { provider: m[1].toLowerCase(), owner: stripGit(owner), repo: stripGit(m[4]) };
    }
    // git@github.com:owner/repo.git  (SSH GitHub)
    m = u.match(/git@(github|gitlab)\.com:([^:]+)$/i);
    if (m) {
        const pathPart = m[2].trim();
        const parts = pathPart.replace(/\/$/, '').split('/');
        const repo = stripGit(parts.pop());
        const owner = stripGit(parts.join('/'));
        return { provider: m[1].toLowerCase(), owner, repo };
    }
    // dh / git://
    m = u.match(/^git:\/\/(github|gitlab)\.com\/([^ ]+)$/i);
    if (m) {
        const parts = m[2].replace(/\/$/, '').split('/');
        return { provider: m[1].toLowerCase(), owner: stripGit(parts.slice(0, -1).join('/')), repo: stripGit(parts[parts.length - 1]) };
    }
    return null;
}

async function detectRepo() {
    const remotes = await runGit(['remote', '-v'], PROJECT_ROOT);
    const remoteLine = (remotes.output.split('\n')[0] || '').trim();
    const remoteUrl = remoteLine.replace(/^origin\s+/, '').replace(/\s+\(fetch\)$/, '').trim();
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], PROJECT_ROOT);
    const isRepo = branch.code === 0;

    const info = {
        isRepo,
        branch: isRepo ? branch.output.trim() : '',
        remoteUrl: remoteUrl || '',
        provider: null,
        owner: null,
        repo: null
    };
    const parsed = parseRemoteUrl(remoteUrl);
    if (parsed) {
        info.provider = parsed.provider;
        info.owner = parsed.owner;
        info.repo = parsed.repo;
    }
    return info;
}

// ===== CRIA/VOCÊ id da próxima versão (semver por tags) =====
function nextVersion(current) {
    if (!current) return 'v1.0.0';
    const m = String(current).replace(/^v/, '').split('.');
    const major = parseInt(m[0]) || 0;
    const minor = parseInt(m[1]) || 0;
    const patch = parseInt(m[2]) || 0;
    m[2] = String(patch + 1);
    return 'v' + m[0] + '.' + m[1] + '.' + m[2];
}

async function latestVersionTag() {
    const tags = await runGit(['tag', '--sort=-version:refname'], PROJECT_ROOT);
    if (tags.code !== 0) return null;
    const list = tags.output.split('\n').map(s => s.trim()).filter(s => /^v?\d+\.\d+\.\d+/.test(s) && !s.includes('-'));
    return list[0] || null;
}

app.post('/api/git/detect', async (req, res) => {
    try {
        const info = await detectRepo();
        const lastTag = info.isRepo ? await latestVersionTag() : null;
        res.json({
            success: true,
            ...info,
            latestTag: lastTag,
            nextTag: nextVersion(lastTag)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/git/publish', async (req, res) => {
    const { bump = 'auto', message, useExisting } = req.body;
    try {
        const status = await runGit(['status', '--porcelain'], PROJECT_ROOT);
        if (status.code !== 0) {
            return res.status(500).json({ error: 'git não encontrado ou projeto não é repositório' });
        }
        const hasChanges = status.output.trim().length > 0;

        let tag;
        if (useExisting) {
            tag = useExisting;
        } else {
            tag = nextVersion(await latestVersionTag());
        }

        const commitMsg = message || `🔖 versão ${tag}`;
        if (hasChanges) {
            await runGit(['add', '-A'], PROJECT_ROOT);
            await runGit(['commit', '-m', commitMsg], PROJECT_ROOT);
        }
        const tagRes = await runGit(['tag', '-a', tag, '-m', `Release ${tag}`], PROJECT_ROOT);
        const push = await runGit(['push', 'origin', 'HEAD', '--follow-tags'], PROJECT_ROOT);

        res.json({
            success: true,
            tag,
            hadChanges: hasChanges,
            commit: true,
            tagCode: tagRes.code,
            pushCode: push.code,
            output: push.output
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const recent = logBuffer.slice(-limit).reverse();
    res.json({ count: logBuffer.length, logs: recent });
});

// ===== EXPLORADOR =====
function getRootLocations() {
    const roots = [];
    if (process.platform === 'win32') {
        const home = os.homedir();
        if (home && home !== '') roots.push({ name: '🏠 Usuário', path: home, isDirectory: true });
        for (let code = 65; code <= 90; code++) {
            const letter = String.fromCharCode(code);
            try {
                if (fs.existsSync(`${letter}:\\`)) {
                    roots.push({ name: `${letter}:\\`, path: `${letter}:\\`, isDirectory: true });
                }
            } catch (e) {}
        }
    } else {
        roots.push({ name: '/', path: '/', isDirectory: true });
        const home = os.homedir();
        if (home && home !== '/') roots.push({ name: '🏠 Usuário', path: home, isDirectory: true });
    }
    return roots;
}

app.post('/api/explorer/roots', (req, res) => {
    const roots = getRootLocations();
    res.json({ success: true, roots });
});

app.post('/api/explorer/list', (req, res) => {
    let { path: dirPath } = req.body;
    console.log(`📂 Explorador listando: ${dirPath}`);

    if (!dirPath) {
        return res.status(400).json({ error: 'Caminho não especificado' });
    }

    // Resolve caminhos relativos contra a raiz do projeto
    if (!path.isAbsolute(dirPath)) {
        const resolved = resolveSafePath(dirPath);
        if (!resolved) {
            return res.status(400).json({ error: 'Caminho fora do projeto' });
        }
        dirPath = resolved;
    }

    if (!fs.existsSync(dirPath)) {
        return res.status(404).json({ error: `Diretório não encontrado: ${dirPath}` });
    }

    if (!fs.statSync(dirPath).isDirectory()) {
        return res.status(400).json({ error: 'Caminho não é um diretório' });
    }

    const files = listDirectory(dirPath);
    res.json({ success: true, files, currentPath: dirPath });
});

app.post('/api/chat', async (req, res) => {
    const { message, projectPath } = req.body;
    try {
        if (projectPath) {
            setProjectRoot(projectPath);
        }
        const plan = await analyzeTask(message, null);
        const response = await executePlan(plan, null);
        res.json({ success: true, response });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== EMPACOTAMENTO / BUILD =====
const BUILD_CWD = path.join(__dirname, '..');

function broadcastBuild(line) {
    const payload = JSON.stringify({ type: 'build-output', line });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch (e) {}
        }
    }
}

function broadcastBuildStatus(status) {
    const payload = JSON.stringify({ type: 'build-status', status });
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(payload); } catch (e) {}
        }
    }
}

app.post('/api/build', async (req, res) => {
    const platform = (req.body && req.body.platform) || 'win';
    const arch = (req.body && req.body.arch) || 'x64';
    const format = (req.body && req.body.format) || 'nsis';

    const errors = runner.validateBuildTarget({ platform, arch, format });
    if (errors.length) {
        return res.status(400).json({ success: false, error: errors.join('; ') });
    }
    if (runner.isBuildRunning()) {
        return res.status(409).json({ success: false, error: 'Já existe um build em andamento.' });
    }

    try {
        const { code } = await runner.startBuild({
            platform,
            arch,
            format,
            cwd: BUILD_CWD,
            onLine: broadcastBuild
        });
        broadcastBuildStatus(code === 0 ? 'done' : 'error');
        res.json({ success: true });
    } catch (e) {
        broadcastBuildStatus('error');
        res.status(e.status || 500).json({ success: false, error: e.message });
    }
});

app.post('/api/build/cancel', (req, res) => {
    const cancelled = runner.cancelBuild(broadcastBuild);
    if (cancelled) broadcastBuildStatus('cancelled');
    res.json({ success: true, cancelled });
});

// ===== WEBSOCKET =====

// Cria o callback onChunk padrão que converte eventos do agente em mensagens WS.
function buildWsOnChunk(ws) {
    return (agent, text) => {
        if (agent === 'file-status') {
            try {
                const statusData = JSON.parse(text);
                ws.send(JSON.stringify({ type: 'file-status', files: statusData }));
            } catch (e) {}
            return;
        }
        if (agent === 'plan') {
            ws.send(JSON.stringify({ type: 'plan', total: Number(text) || 0 }));
            return;
        }
        if (agent === 'activity') {
            try {
                ws.send(JSON.stringify({ type: 'activity-event', ...JSON.parse(text) }));
            } catch (e) {}
            return;
        }
        if (agent === 'interaction') {
            try {
                const payload = JSON.parse(text);
                ws.send(JSON.stringify({ type: payload.kind, ...payload }));
            } catch (e) {}
            return;
        }
        if (agent === 'todo') {
            try {
                ws.send(JSON.stringify({ type: 'todo', todos: JSON.parse(text) }));
            } catch (e) {}
            return;
        }
        ws.send(JSON.stringify({ type: 'chunk', agent: agent || 'Sistema', content: text }));
    };
}

// Aplica (ou submete à aprovação) as alterações feitas por um agente/provedor.
// Em reviewMode, reverte as alterações no disco, guarda o conteúdo novo e envia
// um pedido de aprovação. Sem reviewMode, mantém as alterações, faz backup dos
// originais e roda a validação pós-execução. Retorna { changed, pending,
// rolledBack, modifiedFiles } para o chamador decidir como finalizar.
async function applyAgentChanges({ beforeContents, changes, agentResult, provider, label, reviewMode, ws, onChunk, task, controller, onPlan }) {
    if (!changes || changes.length === 0) return { changed: false };

    if (reviewMode) {
        const newContents = new Map();
        for (const c of changes) {
            if (c.action === 'modificar' || c.action === 'criar') {
                const absPath = path.join(PROJECT_ROOT, ...c.file.split('/'));
                try { newContents.set(c.file, fs.readFileSync(absPath, 'utf-8')); } catch (e) {}
            }
        }
        for (const c of changes) {
            const absPath = path.join(PROJECT_ROOT, ...c.file.split('/'));
            if (c.action === 'modificar' || c.action === 'deletar') {
                const orig = beforeContents.get(c.file);
                if (orig !== undefined) {
                    backupFromContent(c.file, orig);
                    try { fs.writeFileSync(absPath, orig, 'utf-8'); } catch (e) {}
                }
            } else if (c.action === 'criar') {
                try { fs.unlinkSync(absPath); } catch (e) {}
            }
        }
        ws.send(JSON.stringify({ type: 'refresh' }));
        const planId = crypto.randomBytes(8).toString('hex');
        const arquivos = changes.map(c => {
            const entry = { caminho: c.file, acao: c.action, explicacao: '', conteudo: newContents.get(c.file) || c.content || '' };
            if (c.action === 'modificar') {
                entry.originalConteudo = beforeContents.get(c.file) || '';
            }
            return entry;
        });
        const plan = { id: planId, plan: { resumo: `${label}: ${changes.length} arquivo(s)`, arquivos }, controller, task, provider };
        if (onPlan) onPlan(plan);
        ws.send(JSON.stringify({ type: 'approval', planId, resumo: `${label}: ${changes.length} arquivo(s)`, total: changes.length, arquivos }));
        return { changed: true, pending: true };
    }

    if (onChunk) onChunk('plan', String(changes.length));
    for (const c of changes) {
        if (c.action === 'modificar' || c.action === 'deletar') {
            const orig = beforeContents.get(c.file);
            if (orig !== undefined) backupFromContent(c.file, orig);
        }
        const payload = { file: c.file, action: c.action, status: c.action === 'criar' ? 'created' : c.action === 'deletar' ? 'deleted' : 'modified' };
        if (c.action === 'criar') {
            payload.before = '';
            payload.after = readProjectFileContent(c.file);
        } else if (c.action === 'deletar') {
            payload.before = beforeContents.get(c.file) || '';
            payload.after = '';
        } else {
            payload.before = beforeContents.get(c.file) || '';
            payload.after = readProjectFileContent(c.file);
        }
        if (onChunk) onChunk('file-status', JSON.stringify([payload]));
        if (onChunk) onChunk('Sistema', `✅ ${c.file} (${c.action})\n`);
    }
    ws.send(JSON.stringify({ type: 'refresh' }));
    const modifiedFiles = changes.filter(c => c.action !== 'deletar').map(c => c.file);
    let rolledBack = false;
    if (modifiedFiles.length) {
        try {
            const diag = await runPostExecutionDiagnostics(modifiedFiles, agentResult);
            if (diag && diag.rolledBack) {
                rolledBack = true;
                ws.send(JSON.stringify({ type: 'rollback', message: 'Alteracoes revertidas devido a erros' }));
            }
        } catch (e) {}
    }
    return { changed: true, pending: false, rolledBack, modifiedFiles };
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const origin = (req.headers && req.headers.origin) || '';
    if (origin && !isLocalOrigin(origin)) {
        ws.close(1008, 'Origin não permitida');
        return;
    }
    console.log('🔌 Cliente WebSocket conectado');
    let streamController = null;
    let pendingPlan = null;

    // Watchdog de segurança: nenhuma tarefa pode ficar rodando para sempre.
    // Se o fluxo inteiro exceder o limite, aborta o controller e o catch envia
    // um erro ao cliente — a UI nunca fica presa em "Enviando.../Executando".
    let taskWatchdogFired = false;
    let taskWatchdogTimer = null;
    const TASK_WATCHDOG_MS = 8 * 60 * 1000;
    function armTaskWatchdog() {
        taskWatchdogFired = false;
        if (taskWatchdogTimer) clearTimeout(taskWatchdogTimer);
        taskWatchdogTimer = setTimeout(() => {
            if (streamController) {
                taskWatchdogFired = true;
                console.error('⏰ [watchdog] Tarefa excedeu o tempo máximo (' + (TASK_WATCHDOG_MS / 60000) + 'min) — abortando');
                try { streamController.abort(); } catch (e) {}
            }
        }, TASK_WATCHDOG_MS);
    }
    function clearTaskWatchdog() {
        if (taskWatchdogTimer) { clearTimeout(taskWatchdogTimer); taskWatchdogTimer = null; }
    }

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        if (!data.token || data.token !== BACKEND_TOKEN) {
            ws.send(JSON.stringify({ type: 'error', content: '❌ Não autorizado' }));
            ws.close();
            return;
        }

        if (data.type === 'cancel') {
            clearTaskWatchdog();
            killAllChildProcesses();
            const restored = restoreProjectSnapshot();
            const restoredCount = restored.count;
            if (streamController) {
                streamController.abort();
                streamController = null;
                pendingPlan = null;
                const msg = restoredCount > 0
                    ? `⏹️ Tarefa cancelada — ${restoredCount} arquivo(s) restaurado(s)`
                    : '⏹️ Tarefa cancelada';
                ws.send(JSON.stringify({ type: 'cancelled', restoredCount, restoredFiles: restored.files }));
                if (restoredCount > 0) ws.send(JSON.stringify({ type: 'refresh' }));
            }
            return;
        }

        if (data.type === 'interaction-response') {
            const entry = pendingInteractions.get(data.id);
            if (entry) {
                pendingInteractions.delete(data.id);
                entry.resolve(data.value);
            }
            return;
        }

        if (data.type === 'remote-exec') {
            const { command } = data;
            if (!command) { ws.send(JSON.stringify({ type: 'error', content: 'Comando vazio' })); return; }
            if (!remote.isConnected()) { ws.send(JSON.stringify({ type: 'error', content: 'Nenhuma conexao remota ativa. Use /api/remote/connect primeiro.' })); return; }
            try {
                remote.execRemoteStream(command, (text) => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'remote-output', text }));
                });
            } catch (e) {
                ws.send(JSON.stringify({ type: 'error', content: 'Erro remoto: ' + e.message }));
            }
            return;
        }

        if (data.type === 'stream') {
            const { message: task, projectPath, mode, history } = data;

            if (projectPath) {
                setProjectRoot(projectPath);
            }

            streamController = new AbortController();
            armTaskWatchdog();

            const onChunk = buildWsOnChunk(ws);

            setAgentStreamCallback(onChunk);

            try {
                _lastProjectSnapshot = snapshotProjectContents();
                _lastProjectFileList = new Set(snapshotProjectFiles().keys());
                const model = data.model || 'gemini-3.5';
                const provider = data.provider || 'gemini';
                const mode = data.mode || 'cowork';
                const reviewMode = data.reviewMode === true;
                // Modelo escolhido no seletor do chat: usado por TODOS os provedores
                // nas chamadas abaixo (agente, exploração, análise, respostas).
                _currentTaskModel = model;
                // Tarefas grandes ganham tetos completos; as simples ficam econômicas.
                _currentTaskComplexity = isComplexTask(task) ? 'complex' : 'simple';

                if (data.images && data.images.length) setPendingImages(data.images);

                let effectiveMode = mode;
                let effectiveReviewMode = reviewMode;
                if (mode === 'auto' || mode === 'smart') {
                    const classification = classifyRequest(task);
                    console.log(`[smart] ${classification.route}: ${classification.reason} | "${task.slice(0, 80)}"`);
                    if (onChunk) onChunk('Sistema', `🤖 Smart: ${classification.reason}\n`);
                    if (classification.route === 'answer') {
                        onChunk('Assistente', '');
                        const answer = await callAI(provider, `${LANGUAGE_RULE}\n\nResponda de forma concisa e direta (máximo 3 frases): ${task}`, (agent, text) => {
                            if (agent === 'text' || agent === 'Assistente') onChunk('Assistente', text);
                        }, streamController.signal);
                        ws.send(JSON.stringify({ type: 'done', summary: answer ? answer.slice(0, 200).trim() : 'Respondido ✅', command: task }));
                        return;
                    }
                    // 'direct' e 'options' → execução direta do agente (estilo opencode),
                    // sem o fluxo de opções/aprovação que travava tarefas abertas.
                    effectiveMode = 'agent';
                    effectiveReviewMode = false;
                    if (onChunk) onChunk('Sistema', `📋 Modo: 🚀 Direto\n`);
                    data.reviewMode = false;
                }

                if (effectiveMode === 'agent') {
                    const label = provider === 'opencode' ? '🟣 OpenCode' : provider === 'deepseek' ? '🔵 DeepSeek' : provider === 'gemini' ? '🟢 Gemini' : provider === 'claude' ? '🟣 Claude' : '🤖 ' + provider.toUpperCase();
                    if (onChunk) onChunk('Sistema', label + ' — executando...\n');

                    const projectCtx = `ESTRUTURA DO PROJETO:\n${getProjectCache()}`;
                    const agentTaskWithCtx = `${projectCtx}${LANGUAGE_RULE}\n\nTAREFA: ${task}`;

                    const agentBeforeContents = snapshotProjectContents();
                    const agentBefore = snapshotProjectFiles();

                    let agentResult = '';
                    if (provider === 'opencode') {
                        await callOpenCode(agentTaskWithCtx, (chunk) => {
                            agentResult += chunk;
                            if (onChunk) onChunk('Assistente', chunk);
                        }, streamController.signal, null, (toolEvent) => {
                            if (onChunk) onChunk('activity', JSON.stringify(toolEvent));
                        });
                    } else {
                        agentResult = await runAgentLoop(agentTaskWithCtx, onChunk, streamController.signal, mode, Array.isArray(history) ? history : [], provider);
                    }

                    const agentChanges = diffSnapshots(agentBefore, snapshotProjectFiles());

                    if (agentChanges.length > 0) {
                        const applied = await applyAgentChanges({
                            beforeContents: agentBeforeContents,
                            changes: agentChanges,
                            agentResult,
                            provider,
                            label: provider,
                            reviewMode: data.reviewMode,
                            ws,
                            onChunk,
                            task,
                            controller: streamController,
                            onPlan: (p) => { p.mode = 'agent'; pendingPlan = p; }
                        });
                        if (applied.pending) return;
                        if (applied.rolledBack) {
                            ws.send(JSON.stringify({ type: 'done', summary: 'Alterações revertidas (testes falharam)', command: task }));
                            return;
                        }
                        const agentSummary = agentChanges.length > 0 ? `${agentChanges.length} arquivo(s) alterado(s)` : (agentResult ? agentResult.slice(0, 200).trim() : 'Concluído');
                        ws.send(JSON.stringify({ type: 'done', summary: agentSummary, modifiedFiles: agentChanges.map(c => c.file), command: task }));
                    } else {
                        ws.send(JSON.stringify({ type: 'done', summary: agentResult ? agentResult.slice(0, 200).trim() : 'Agente concluído ✅', command: task }));
                    }
                    return;
                }

                if (provider === 'opencode' || (model && model.startsWith('opencode/'))) {
                    const openPrompt = buildOpenCodePrompt(task, mode, Array.isArray(history) ? history : []);
                    const beforeContents = snapshotProjectContents();
                    const before = snapshotProjectFiles();
                    let ocFullResponse = '';
                    await callOpenCode(openPrompt, (chunk) => {
                        ocFullResponse += chunk;
                        if (onChunk) onChunk('Assistente', chunk);
                    }, streamController.signal, null, (toolEvent) => {
                        if (onChunk) onChunk('activity', JSON.stringify(toolEvent));
                    });
                    const changes = diffSnapshots(before, snapshotProjectFiles());

                    if (changes.length > 0) {
                        const applied = await applyAgentChanges({
                            beforeContents,
                            changes,
                            agentResult: ocFullResponse.slice(0, 80),
                            provider,
                            label: 'opencode',
                            reviewMode: data.reviewMode,
                            ws,
                            onChunk,
                            task,
                            controller: streamController,
                            onPlan: (p) => { pendingPlan = p; }
                        });
                        if (applied.pending) return;
                        const ocSummary = ocFullResponse.replace(/\n+/g, ' ').slice(0, 150).trim() || `opencode: ${changes.length} arquivo(s) alterado(s)`;
                        ws.send(JSON.stringify({ type: 'done', summary: ocSummary, modifiedFiles: changes.map(c => c.file), command: task }));
                    } else if (/(opção|opções|escolha|qual|Opção \d|recomendada|implementar\?|pergunta|dúvida|qual usar|prefere)/i.test(ocFullResponse)) {
                        const parsed = extractJson(ocFullResponse);
                        if (parsed && (parsed.sugestoes || parsed.arquivos)) {
                            const plan = parsed;
                            const hasSug = Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0;
                            const hasArq = Array.isArray(plan.arquivos) && plan.arquivos.length > 0;
                            const planId = crypto.randomBytes(8).toString('hex');
                            pendingPlan = { id: planId, plan, controller: streamController, task, provider: 'opencode' };
                            const payload = { type: 'approval', planId, resumo: plan.resumo || '', total: hasSug ? plan.sugestoes.length : (plan.arquivos || []).length };
                            if (hasSug) {
                                payload.sugestoes = plan.sugestoes.map((s, i) => ({ id: s.id || 's'+(i+1), titulo: s.titulo || 'Sugestão '+(i+1), descricao: s.descricao || '', impacto: s.impacto || 'médio', arquivos: (s.arquivos || []).map(a => ({ caminho: a.caminho, acao: a.acao || 'modificar', explicacao: a.explicacao || '', conteudo: a.conteudo || '' })) }));
                            } else {
                                payload.arquivos = (plan.arquivos || []).map(a => ({ caminho: a.caminho, acao: a.acao || 'modificar', explicacao: a.explicacao || '', conteudo: a.conteudo || '' }));
                            }
                            ws.send(JSON.stringify(payload));
                        } else {
                            const textOptions = parseTextOptions(ocFullResponse);
                            if (textOptions && textOptions.length >= 2) {
                                const planId = crypto.randomBytes(8).toString('hex');
                                const plan = { resumo: textOptions[0].descricao || 'Escolha uma opção', sugestoes: textOptions };
                                pendingPlan = { id: planId, plan, controller: streamController, task, provider: 'opencode' };
                                ws.send(JSON.stringify({
                                    type: 'approval', planId,
                                    resumo: plan.resumo,
                                    total: textOptions.length,
                                    sugestoes: textOptions.map(s => ({ id: s.id, titulo: s.titulo, descricao: s.descricao, impacto: s.impacto || 'médio', arquivos: [] }))
                                }));
                            } else {
                                const ocSummary = (ocFullResponse || '').replace(/\n+/g, ' ').slice(0, 120).trim() || 'opencode respondeu';
                                ws.send(JSON.stringify({ type: 'done', summary: ocSummary, command: task }));
                            }
                        }
                    } else {
                        const ocSummary = (ocFullResponse || '').replace(/\n+/g, ' ').slice(0, 120).trim() || 'opencode executado';
                        ws.send(JSON.stringify({ type: 'done', summary: ocSummary, command: task }));
                    }
                    return;
                }

                if ((provider === 'openai' || provider === 'claude') && effectiveMode !== 'agent') {
                    if (onChunk) onChunk('Sistema', `🤖 ${provider.toUpperCase()} analisando com ferramentas nativas...\n`);
                    const ntvBeforeContents = snapshotProjectContents();
                    const ntvBefore = snapshotProjectFiles();
                    const ntvResult = await runAgentLoop(task, onChunk, streamController.signal, mode, [], provider);
                    const ntvChanges = diffSnapshots(ntvBefore, snapshotProjectFiles());

                    if (ntvChanges.length > 0) {
                        const applied = await applyAgentChanges({
                            beforeContents: ntvBeforeContents,
                            changes: ntvChanges,
                            agentResult: ntvResult,
                            provider,
                            label: provider,
                            reviewMode: data.reviewMode,
                            ws,
                            onChunk,
                            task,
                            controller: streamController,
                            onPlan: (p) => { pendingPlan = p; }
                        });
                        if (applied.pending) return;
                        const ntvSummary = (ntvResult || '').replace(/\n+/g, ' ').slice(0, 150).trim() || `${provider}: ${ntvChanges.length} arquivo(s)`;
                        ws.send(JSON.stringify({ type: 'done', summary: ntvSummary, modifiedFiles: ntvChanges.map(c => c.file), command: task }));
                    } else {
                        ws.send(JSON.stringify({ type: 'done', summary: ntvResult || `${provider} concluído`, command: task }));
                    }
                    return;
                }

                if (!data.reviewMode && effectiveMode !== 'clarify') {
                    const fastBeforeContents = snapshotProjectContents();
                    const fastBefore = snapshotProjectFiles();

                    let fastExplorationCtx = '';
                    if (task && !classifyIntent(task).includes('question')) {
                        try {
                            if (onChunk) onChunk('Sistema', '🔍 Explorando arquivos...\n');
                            fastExplorationCtx = await runExplorationPhase(task, onChunk, streamController.signal, provider);
                        } catch (e) {}
                    }
                    const fastTaskWithCtx = fastExplorationCtx
                        ? `CONTEXTO DA EXPLORAÇÃO PRÉVIA:\n${fastExplorationCtx}\n\nTAREFA: ${task}`
                        : task;

                    const fastResult = provider === 'opencode'
                        ? '' : await runAgentLoop(fastTaskWithCtx, onChunk, streamController.signal, mode, Array.isArray(history) ? history : [], provider);

                    if (provider === 'opencode') {
                        // fallback to analyzeTask for opencode non-agent
                    } else {
                        const fastChanges = diffSnapshots(fastBefore, snapshotProjectFiles());

                        if (fastChanges.length > 0) {
                            const applied = await applyAgentChanges({
                                beforeContents: fastBeforeContents,
                                changes: fastChanges,
                                agentResult: fastResult,
                                provider,
                                label: provider,
                                reviewMode: false,
                                ws,
                                onChunk,
                                task,
                                controller: streamController,
                                onPlan: () => {}
                            });
                            if (applied.pending) return;
                            if (applied.rolledBack) {
                                ws.send(JSON.stringify({ type: 'done', summary: 'Alterações revertidas (testes falharam)', command: task }));
                                return;
                            }
                            const fastSummary = `${fastChanges.length} arquivo(s) alterado(s)`;
                            ws.send(JSON.stringify({ type: 'done', summary: fastSummary, modifiedFiles: fastChanges.map(c => c.file), command: task }));
                        } else {
                            ws.send(JSON.stringify({ type: 'done', summary: fastResult ? fastResult.slice(0, 200).trim() : 'Concluído ✅', command: task }));
                        }
                        return;
                    }
                }

                let explorationCtx = '';
                if (effectiveMode !== 'agent' && task && !classifyIntent(task).includes('question')) {
                    try {
                        if (onChunk) onChunk('Sistema', '🔍 Explorando arquivos do projeto antes de gerar o plano...\n');
                        explorationCtx = await runExplorationPhase(task, onChunk, streamController.signal, provider);
                        if (explorationCtx && onChunk) onChunk('Sistema', '✅ Exploração concluída. Gerando plano...\n');
                    } catch (e) {}
                }

                const plan = await analyzeTask(task, onChunk, streamController.signal, mode, Array.isArray(history) ? history : [], provider, explorationCtx);
                console.log('[ws:plan] analyzeTask retornou', JSON.stringify({ resumo: (plan.resumo||'').slice(0,60), hasSugestoes: Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0, hasArquivos: Array.isArray(plan.arquivos) && plan.arquivos.length > 0, hasRaw: !!(plan._rawResponse), rawLen: (plan._rawResponse||'').length, sugCount: (plan.sugestoes||[]).length, arqCount: (plan.arquivos||[]).length }));

                let hasSugestoes = Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0;
                let hasArquivos = Array.isArray(plan.arquivos) && plan.arquivos.length > 0;

                if (!hasSugestoes && !hasArquivos) {
                    console.log('[ws:plan] Entrando no retry...');
                    const rawText = (plan._rawResponse || '').trim();
                    const retryPrompt = rawText
                        ? `⚠️ Você respondeu com texto em vez de JSON. Sua resposta foi:\n\n"""\n${rawText.slice(0, 2000)}\n"""\n\nAgora, com base EXATAMENTE nessa sua análise, retorne APENAS este JSON, sem nenhum texto antes ou depois:\n{\n  "resumo": "resumo curto baseado na sua análise",\n  "sugestoes": [\n    {"id":"s1","titulo":"Opção A (completa): ...","descricao":"O que inclui. 2 frases.","impacto":"alto","arquivos":[]},\n    {"id":"s2","titulo":"Opção B (média): ...","descricao":"O que inclui. 2 frases.","impacto":"médio","arquivos":[]},\n    {"id":"s3","titulo":"Opção C (simples): ...","descricao":"O que inclui. 2 frases.","impacto":"baixo","arquivos":[]},\n    {"id":"custom","titulo":"Personalizado","descricao":"Descreva exatamente o que você deseja","impacto":"médio","arquivos":[]}\n  ]\n}\n\nREGRAS:\n- SEMPRE 4 opções: completa, média, simples, personalizado\n- Use as informações da sua análise anterior nos títulos e descrições\n- "arquivos" sempre vazio ([]) — o usuário escolhe a opção primeiro\n- Apenas JSON. Nada de texto. Nada de markdown. Comece com { e termine com }.`
                        : `⚠️ EMERGÊNCIA: Você respondeu com texto em vez de JSON.\n\nBaseado na solicitação: "${task}"\n\nRetorne APENAS JSON com sugestoes no formato:\n{\n  "resumo": "...",\n  "sugestoes": [\n    {"id":"s1","titulo":"Opção A (completa): ...","descricao":"...","impacto":"alto","arquivos":[]},\n    {"id":"s2","titulo":"Opção B (média): ...","descricao":"...","impacto":"médio","arquivos":[]},\n    {"id":"s3","titulo":"Opção C (simples): ...","descricao":"...","impacto":"baixo","arquivos":[]},\n    {"id":"custom","titulo":"Personalizado","descricao":"Descreva exatamente o que você deseja","impacto":"médio","arquivos":[]}\n  ]\n}\n\nApenas JSON. Nada de texto. Comece com { e termine com }.`;

                    if (onChunk) onChunk('Sistema', '🔄 Reforçando solicitação de opções...\n');
                    try {
                        const retryResponse = await callAI(provider, retryPrompt, null, streamController.signal);
                        const retryPlan = extractJson(retryResponse);
                        console.log('[ws:plan] Retry concluído', JSON.stringify({ hasRetryPlan: !!retryPlan, retrySugCount: retryPlan ? (retryPlan.sugestoes||[]).length : 0, retryArqCount: retryPlan ? (retryPlan.arquivos||[]).length : 0 }));
                        if (retryPlan) {
                            plan.sugestoes = retryPlan.sugestoes;
                            plan.arquivos = retryPlan.arquivos;
                            if (retryPlan.resumo) {
                                plan.resumo = retryPlan.resumo;
                                if (onChunk) onChunk('Assistente', '📋 ' + retryPlan.resumo + '\n');
                            }
                            hasSugestoes = Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0;
                            hasArquivos = Array.isArray(plan.arquivos) && plan.arquivos.length > 0;
                        }
                    } catch (retryError) {
                        console.error('[ws] Retry falhou, usando fallback:', retryError.message);
                    }
                }

                if (!hasSugestoes && !hasArquivos) {
                    console.log('[ws:plan] Entrando no fallback...');
                    const fallback = buildFallbackSugestoes(task, plan._rawResponse || plan.resumo);
                    if (onChunk) onChunk('Sistema', '📋 Gerando opções padrão...\n');
                    if (onChunk && fallback.resumo) onChunk('Assistente', '📋 ' + fallback.resumo + '\n');
                    plan.resumo = fallback.resumo;
                    plan.sugestoes = fallback.sugestoes;
                    plan.arquivos = [];
                    hasSugestoes = true;
                }

                const planId = crypto.randomBytes(8).toString('hex');
                pendingPlan = { id: planId, plan, controller: streamController, task, provider };

                if (hasArquivos && !hasSugestoes) {
                    try {
                        let filesToExecute = plan.arquivos || [];
                        await executePlan({ resumo: plan.resumo || '', arquivos: filesToExecute }, onChunk, streamController.signal);
                        ws.send(JSON.stringify({ type: 'refresh' }));
                        const modifiedFiles = (filesToExecute || []).filter(f => f.acao !== 'deletar').map(f => f.caminho);
                        if (modifiedFiles.length) {
                            const result = await runPostExecutionDiagnostics(modifiedFiles, plan.resumo);
                            if (result && result.rolledBack) ws.send(JSON.stringify({ type: 'rollback', message: 'Alteracoes revertidas devido a erros' }));
                        }
                        ws.send(JSON.stringify({ type: 'done', summary: plan.resumo || 'Alterações aplicadas', modifiedFiles, command: pendingPlan.task || '' }));
                    } catch (e) {
                        logError('plan-execute', e.message, pendingPlan?.task || '');
                        ws.send(JSON.stringify({ type: 'error', content: '❌ ' + (e.message || 'Erro na execução') }));
                    } finally {
                        streamController = null;
                    }
                    return;
                }

                const payload = {
                    type: 'approval',
                    planId,
                    total: hasSugestoes
                        ? plan.sugestoes.reduce((n, s) => n + (Array.isArray(s.arquivos) ? s.arquivos.length : 0), 0)
                        : plan.arquivos.length,
                    resumo: plan.resumo || ''
                };
                if (hasSugestoes) {
                    payload.sugestoes = plan.sugestoes.map((s, i) => ({
                        id: s.id || 's' + (i + 1),
                        titulo: s.titulo || 'Sugestão ' + (i + 1),
                        descricao: s.descricao || '',
                        impacto: s.impacto || 'médio',
                        arquivos: (Array.isArray(s.arquivos) ? s.arquivos : []).map(a => ({
                            caminho: a.caminho,
                            acao: a.acao,
                            explicacao: a.explicacao || '',
                            conteudo: a.conteudo || ''
                        }))
                    }));
                } else {
                    payload.arquivos = plan.arquivos.map(a => {
                        const entry = {
                            caminho: a.caminho,
                            acao: a.acao,
                            explicacao: a.explicacao || '',
                            conteudo: a.conteudo || ''
                        };
                        if (a.acao === 'modificar') {
                            try {
                                const absPath = path.join(PROJECT_ROOT, ...a.caminho.split('/'));
                                if (fs.existsSync(absPath)) entry.originalConteudo = fs.readFileSync(absPath, 'utf-8');
                            } catch (e) {}
                        }
                        return entry;
                    });
                }
                console.log('[ws] Enviando approval payload', JSON.stringify({ planId, hasSugestoes, sugestoesCount: hasSugestoes ? payload.sugestoes.length : 0, arquivosCount: payload.arquivos ? payload.arquivos.length : 0, total: payload.total, resumo: (payload.resumo||'').slice(0, 60) }));
                ws.send(JSON.stringify(payload));
            } catch (error) {
                clearTaskWatchdog();
                clearPendingImages();
                const cancelled = error && error.name === 'AbortError';
                let content;
                let type;
                if (taskWatchdogFired) {
                    type = 'error';
                    content = '⏰ A tarefa excedeu o tempo máximo (10 minutos) e foi interrompida. Tente novamente ou divida o pedido em etapas menores.';
                } else if (cancelled) {
                    type = 'cancelled';
                    content = '⏹️ Tarefa cancelada';
                } else {
                    type = 'error';
                    content = `❌ ${error.message}`;
                    logError('agent-loop', error.message, task ? task.slice(0, 300) : '');
                    const alternatives = [];
                    if (config.gemini?.apiKey) alternatives.push('Gemini');
                    if (config.deepseek?.apiKey) alternatives.push('DeepSeek');
                    if (config.openai?.apiKey) alternatives.push('OpenAI');
                    if (config.claude?.apiKey) alternatives.push('Claude');
                    const currentProvider = data.provider ? data.provider.charAt(0).toUpperCase() + data.provider.slice(1) : '';
                    const others = alternatives.filter(p => p.toLowerCase() !== (currentProvider || '').toLowerCase());
                    if (others.length > 0) {
                        content += `\n💡 Tente trocar para: ${others.join(', ')} nas Configurações.`;
                    }
                }
                ws.send(JSON.stringify({ type, content }));
            }
            return;
        }

        if (data.type === 'execute') {
            if (!pendingPlan || data.planId !== pendingPlan.id) {
                ws.send(JSON.stringify({ type: 'error', content: '❌ Plano expirado, envie novamente' }));
                return;
            }

            const { plan, controller, task, provider, mode: planMode } = pendingPlan;
            pendingPlan = null;
            streamController = controller;
            armTaskWatchdog();

            const onChunk = buildWsOnChunk(ws);

            if (planMode === 'agent') {
                try {
                    await runAgentAndCapture(ws, task, onChunk, streamController, [], provider);
                } catch (error) {
                    clearTaskWatchdog();
                    logError('plan-execute', error.message, task ? task.slice(0, 300) : '');
                    ws.send(JSON.stringify({ type: 'error', content: '❌ ' + (error.message || 'Erro na execução') }));
                }
                return;
            }

            setAgentStreamCallback(onChunk);

            try {
                _lastProjectSnapshot = snapshotProjectContents();
                _lastProjectFileList = new Set(snapshotProjectFiles().keys());
                let filesToExecute;
                if (Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0) {
                    const selected = new Set(Array.isArray(data.selecionadas) ? data.selecionadas : []);
                    const selectedSuggestions = plan.sugestoes.filter(s => selected.has(s.id));
                    filesToExecute = [];
                    for (const s of selectedSuggestions) {
                        if (Array.isArray(s.arquivos)) {
                            filesToExecute.push(...s.arquivos);
                        }
                    }
                    if (filesToExecute.length === 0 && selectedSuggestions.length > 0) {
                        const hasCustom = selected.has('custom') && data.customRequest;
                        const selTitles = hasCustom ? data.customRequest : selectedSuggestions.filter(s => s.id !== 'custom').map(s => s.titulo).join('; ');
                        const selDescs = hasCustom ? data.customRequest : selectedSuggestions.filter(s => s.id !== 'custom').map(s => s.descricao).join('; ');
                        if (onChunk) onChunk('Sistema', '🔨 Implementando opção selecionada...\n');

                        if (provider === 'opencode') {
                            const beforeSnap = snapshotProjectFiles();
                            const beforeContents = snapshotProjectContents();
                            const implPrompt = hasCustom
                                ? `Solicitação do usuário: "${data.customRequest}"\n\nSolicitação original: "${task}"\n\nImplemente diretamente nos arquivos do projeto.`
                                : `Solicitação original: "${task}"\n\nOpção escolhida: ${selTitles}\nDescrição: ${selDescs}\n\nImplemente esta opção diretamente nos arquivos do projeto.`;
                            await callOpenCode(implPrompt, (chunk) => {
                                if (onChunk) onChunk('Assistente', chunk);
                            }, controller.signal, null, (toolEvent) => {
                                if (onChunk) onChunk('activity', JSON.stringify(toolEvent));
                            });
                            const ocChanges = diffSnapshots(beforeSnap, snapshotProjectFiles());
                            if (ocChanges.length > 0) {
                                for (const change of ocChanges) {
                                    if (change.action === 'modificar' || change.action === 'deletar') {
                                        const orig = beforeContents.get(change.file);
                                        if (orig !== undefined) backupFromContent(change.file, orig);
                                    }
                                    if (onChunk) onChunk('file-status', JSON.stringify([{ file: change.file, action: change.action, status: 'done', before: change.action === 'deletar' ? (beforeContents.get(change.file) || '') : '', after: change.action === 'deletar' ? '' : readProjectFileContent(change.file) }]));
                                    if (onChunk) onChunk('Sistema', `📄 ${change.action.toUpperCase()}: ${change.file}\n`);
                                }
                                filesToExecute = ocChanges.map(c => ({ caminho: c.file, acao: c.action }));
                                ws.send(JSON.stringify({ type: 'refresh' }));
                                const modifiedFilesOc = ocChanges.filter(c => c.action !== 'deletar').map(c => c.file);
                                if (modifiedFilesOc.length) {
                                    const result = await runPostExecutionDiagnostics(modifiedFilesOc, plan.resumo);
                                    if (result && result.rolledBack) ws.send(JSON.stringify({ type: 'rollback', message: 'Alteracoes revertidas devido a erros' }));
                                }
                                ws.send(JSON.stringify({ type: 'done', summary: 'opencode: ' + ocChanges.length + ' arquivo(s) alterado(s)', modifiedFiles: ocChanges.filter(c => c.action !== 'deletar').map(c => c.file), command: task }));
                            } else {
                                if (onChunk) onChunk('Sistema', '⚠️ opencode não gerou arquivos. Seja mais específico ou use a opção "Personalizado".\n');
                                ws.send(JSON.stringify({ type: 'done', summary: 'Nenhum arquivo gerado. Seja mais específico.', command: task }));
                            }
                            return;
                        } else {
                            if (onChunk) onChunk('Sistema', '🔨 Executando com agente...\n');
                            const buildImplPrompt = (force) => {
                                const base = `Solicitação do usuário: "${task}"\nOpção escolhida: ${selTitles}\n${selDescs}\n\nESTRUTURA DO PROJETO:\n${getProjectCache()}`;
                                const instr = force
                                    ? `\n\nATENÇÃO (obrigatório): escolha UMA melhoria concreta e implemente-a AGORA usando a ferramenta write_file com o código modificado. Ler arquivos com read_file é permitido, mas você DEVE terminar chamando write_file. Responder apenas com texto, JSON ou plano NÃO é implementar e não será aceito.`
                                    : `\n\nTAREFA: escolha UMA melhoria concreta e implemente-a escrevendo código com a ferramenta write_file (ex.: adicionar validação, tratar erros, extrair função, melhorar uma tela, adicionar um recurso pequeno). Use read_file para entender o arquivo alvo e então chame write_file com o código modificado. O resultado esperado é código salvo nos arquivos — não responda com texto, JSON ou plano.`;
                                return base + instr;
                            };
                            const agentBeforeSnap = snapshotProjectFiles();
                            const agentBeforeContents = snapshotProjectContents();
                            let agentImplResult = await runAgentLoop(buildImplPrompt(false), onChunk, controller.signal, 'agent', [], provider);
                            let agentImplChanges = diffSnapshots(agentBeforeSnap, snapshotProjectFiles());
                            if (agentImplChanges.length === 0) {
                                if (onChunk) onChunk('Sistema', '⚠️ O agente apenas analisou sem implementar. Reforçando instrução...\n');
                                agentImplResult = await runAgentLoop(buildImplPrompt(true), onChunk, controller.signal, 'agent', [], provider);
                                agentImplChanges = diffSnapshots(agentBeforeSnap, snapshotProjectFiles());
                            }
                            if (agentImplChanges.length > 0) {
                                for (const c of agentImplChanges) {
                                    if (c.action === 'modificar' || c.action === 'deletar') {
                                        const orig = agentBeforeContents.get(c.file);
                                        if (orig !== undefined) backupFromContent(c.file, orig);
                                    }
                                    if (onChunk) onChunk('file-status', JSON.stringify([{ file: c.file, action: c.action, status: 'done', before: c.action === 'deletar' ? (agentBeforeContents.get(c.file) || '') : '', after: c.action === 'deletar' ? '' : readProjectFileContent(c.file) }]));
                                    if (onChunk) onChunk('Sistema', `📄 ${c.action.toUpperCase()}: ${c.file}\n`);
                                }
                                filesToExecute = agentImplChanges.map(c => ({ caminho: c.file, acao: c.action }));
                                plan.resumo = agentImplResult ? agentImplResult.slice(0, 200) : 'Agente concluído';
                            } else {
                                if (onChunk) onChunk('Sistema', '⚠️ O agente analisou mas não alterou nenhum arquivo. Seja mais específico ou use a opção "Personalizado".\n');
                                ws.send(JSON.stringify({ type: 'done', summary: 'Nenhum arquivo alterado — o agente analisou mas não implementou. Seja mais específico ou use "Personalizado".', command: task }));
                                return;
                            }
                        }
                    }
                } else {
                    filesToExecute = data.arquivos || plan.arquivos || [];
                    if (data.nota && onChunk) onChunk('Sistema', `📝 Nota: ${data.nota}\n`);
                }
                await executePlan({ resumo: plan.resumo || '', arquivos: filesToExecute }, onChunk, controller.signal);
                const modifiedFiles = (filesToExecute || []).filter(f => f.acao !== 'deletar').map(f => f.caminho);
                if (modifiedFiles.length) {
                    const result = await runPostExecutionDiagnostics(modifiedFiles, plan.resumo);
                    if (result && result.rolledBack) ws.send(JSON.stringify({ type: 'rollback', message: 'Alteracoes revertidas devido a erros' }));
                }
                ws.send(JSON.stringify({ type: 'done', summary: plan.resumo || 'Alterações aplicadas', modifiedFiles, command: task }));
            } catch (error) {
                clearTaskWatchdog();
                const cancelled = error && error.name === 'AbortError';
                if (taskWatchdogFired) {
                    ws.send(JSON.stringify({ type: 'error', content: '⏰ A tarefa excedeu o tempo máximo (10 minutos) e foi interrompida. Tente novamente ou divida o pedido em etapas menores.' }));
                } else if (!cancelled) {
                    logError('plan-execute', error.message, task ? task.slice(0, 300) : '');
                    ws.send(JSON.stringify({ type: 'error', content: '❌ ' + (error.message || 'Erro na execução') }));
                }
            } finally {
                clearTaskWatchdog();
                streamController = null;
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 Cliente WebSocket desconectado');
        clearTaskWatchdog();
        killAllChildProcesses();
        if (streamController) {
            streamController.abort();
            streamController = null;
        }
        pendingPlan = null;
    });
});

module.exports = { app, server, resolveSafePath, extractJson, setProjectRoot, writeFileContent, 
readFileContent, listBackups, analyzeTask, executePlan, executeAgentTool, parseJsonC, buildOpenCodePrompt, 
snapshotProjectFiles, diffSnapshots, computeDiff, parseRemoteUrl, nextVersion, detectRepo, latestVersionTag, runner, formatCode, 
pushUndoState, undoStack, redoStack, trackTokens, calcCost, getModelPrice, getUsageReport, tokenUsage, listDirectory, 
getAllFiles };

// =============================================
let mcpConfigs = [];
function loadMcpConfig() {
    try {
        const ocPath = path.join(PROJECT_ROOT, 'opencode.json');
        if (fs.existsSync(ocPath)) {
            const oc = JSON.parse(fs.readFileSync(ocPath, 'utf-8'));
            if (oc.mcp && typeof oc.mcp === 'object') {
                mcpConfigs = Object.entries(oc.mcp).map(([name, cfg]) => {
                    const cmdParts = Array.isArray(cfg.command) ? cfg.command : String(cfg.command || '').split(/\s+/).filter(Boolean);
                    return {
                        name,
                        command: cmdParts[0] || '',
                        args: cmdParts.slice(1),
                        env: cfg.environment || {},
                        enabled: cfg.enabled !== false
                    };
                });
            }
        }
    } catch (e) { console.error('[mcp] Erro ao carregar config:', e.message); }
}

async function initMcp() {
    if (mcpConfigs.length === 0) return;
    console.log(`[mcp] Conectando ${mcpConfigs.filter(c => c.enabled).length} servidor(es)...`);
    await mcpManager.connectServers(mcpConfigs);
}

function getMcpTools() { return mcpManager.getAllTools(); }
async function executeMcpTool(name, args) { return await mcpManager.executeTool(name, args); }

// =============================================
//  INICIAR SERVIDOR (APENAS SE EXECUTADO DIRETO)
// =============================================
if (require.main === module) {
    loadMcpConfig();
    initMcp().then(() => {
        console.log('[mcp] Inicialização concluída');
    }).catch(e => console.error('[mcp]', e.message));
    server.listen(PORT, '127.0.0.1', () => {
        startHeartbeat();
        console.log(`✅ Aedificator Codex IDE Backend rodando na porta ${PORT}`);
        console.log(`🔗 http://localhost:${PORT}/api/health`);
        console.log(`📁 Diretório do projeto: ${PROJECT_ROOT}`);
        ensureOpenCodeServer().then(() => {
            console.log('[opencode] Servidor persistente iniciado');
        }).catch(e => {
            console.log(`[opencode] Servidor não iniciado (será criado sob demanda): ${e.message}`);
        });
        fetchUsdBrlRate();
        fetchAiPrices();
        setInterval(fetchUsdBrlRate, 3600000);
        setInterval(fetchAiPrices, 86400000);
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`❌ Porta ${PORT} já está em uso!`);
        } else {
            console.error('❌ Erro no servidor:', error);
        }
    });

    process.on('uncaughtException', (error) => {
        logError('uncaught', error.message || String(error), (error.stack || '').slice(0, 500));
        console.error('❌ Erro não tratado:', error);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        stopOpenCodeServer();
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        logError('unhandled', reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? (reason.stack || '').slice(0, 500) : '');
        console.error('❌ Rejeição não tratada:', reason);
    });

    process.on('SIGINT', () => { if (heartbeatInterval) clearInterval(heartbeatInterval); stopOpenCodeServer(); process.exit(); });
    process.on('SIGTERM', () => { if (heartbeatInterval) clearInterval(heartbeatInterval); stopOpenCodeServer(); process.exit(); });

    console.log('🏗️ Aedificator Codex IDE Backend inicializando...');
    console.log(`📁 Diretório base: ${PROJECT_ROOT}`);
    console.log('🎯 Modo AUTOMÁTICO - Analisa e altera arquivos automaticamente!');
}
