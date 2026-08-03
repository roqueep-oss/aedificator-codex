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
app.use(express.static(frontendDir));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const runner = require('./runner');

const PORT = process.env.PORT || 3001;

// =============================================
//  AUTENTICAÇÃO LOCAL
// =============================================
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || '';

if (!BACKEND_TOKEN) {
    console.log('🔓 Sem BACKEND_TOKEN — servidor sem autenticação (acesso restrito a 127.0.0.1). Defina BACKEND_TOKEN no backend/.env para proteger a API.');
}

// ===== SEGREDO PARA CRIPTOGRAFAR AS CHAVES =====
const BACKEND_SECRET = process.env.BACKEND_SECRET || '';

app.use('/api', (req, res, next) => {
    if (!BACKEND_TOKEN) return next();
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
    const resolvedPath = path.resolve(newPath);
    if (fs.existsSync(resolvedPath)) {
        PROJECT_ROOT = resolvedPath;
        lastRepoInfo = null;
        console.log(`📁 Diretório do projeto alterado para: ${PROJECT_ROOT}`);
        return true;
    }
    console.log(`❌ Diretório não encontrado: ${resolvedPath}`);
    return false;
}

// ===== CONFIGURAÇÃO =====
const OPENCODE_DEFAULT_MODEL = 'opencode/deepseek-v4-flash-free';

let config = {
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || '',
        model: process.env.GEMINI_MODEL || 'gemini-3.5-flash'
    },
    deepseek: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        model: 'deepseek-chat'
    },
    opencode: {
        apiKey: process.env.OPENCODE_API_KEY || '',
        model: OPENCODE_DEFAULT_MODEL
    }
};

const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (savedConfig.gemini?.apiKey) config.gemini.apiKey = decryptSecret(savedConfig.gemini.apiKey);
        if (savedConfig.gemini?.model) config.gemini.model = savedConfig.gemini.model;
        if (savedConfig.deepseek?.apiKey) config.deepseek.apiKey = decryptSecret(savedConfig.deepseek.apiKey);
        if (savedConfig.deepseek?.model) config.deepseek.model = savedConfig.deepseek.model;
        if (savedConfig.opencode?.apiKey) config.opencode.apiKey = decryptSecret(savedConfig.opencode.apiKey);
        if (savedConfig.opencode?.model) config.opencode.model = savedConfig.opencode.model;
        console.log('✅ Configuração carregada');
    } catch (e) {
        console.log('⚠️ Erro ao carregar configuração');
    }
}

function saveConfigToFile() {
    const fileConfig = {
        gemini: { apiKey: encryptSecret(config.gemini.apiKey), model: config.gemini.model },
        deepseek: { apiKey: encryptSecret(config.deepseek.apiKey), model: config.deepseek.model },
        opencode: { apiKey: encryptSecret(config.opencode.apiKey), model: config.opencode.model }
    };
    fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2));
}

// =============================================
//  SISTEMA DE ARQUIVOS
// =============================================

const BACKUP_DIR_NAME = '.aedificator-codex-ide-backup';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', BACKUP_DIR_NAME]);
const MAX_CONTEXT_FILES = 500;

function getProjectPath(relativePath) {
    return path.join(PROJECT_ROOT, relativePath || '');
}

// ===== RESOLVE CAMINHO GARANTINDO QUE FICA DENTRO DO PROJETO =====
function resolveSafePath(relativePath) {
    const root = path.resolve(PROJECT_ROOT);
    const resolved = path.resolve(root, relativePath || '');
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }
    return resolved;
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
        fs.writeFileSync(fullPath, content, 'utf-8');
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
            try { fs.unlinkSync(path.join(dir, v.name)); } catch (e) {}
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
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
            try {
                const isDir = entry.isDirectory();
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
    const model = config.gemini.model || 'gemini-3.5-flash';

    if (!apiKey) {
        throw new Error('Chave API Gemini não configurada!');
    }

    const useStream = !!onChunk;
    const url = useStream
        ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
        : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    }, 120000, signal);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Erro na API Gemini: ${response.status} - ${error}`);
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

    while (true) {
        if (signal && signal.aborted) break;
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
            } catch (e) {}
        }
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
        if (auth.opencode?.key !== apiKey) {
            auth.opencode = { type: 'api', key: apiKey };
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf-8');
            console.log('✅ Chave opencode gravada no auth.json do CLI');
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

// ===== LISTAR MODELOS OPEncode (APENAS FREE) =====
function parseOpenCodeModelsVerbose(raw) {
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
            if (/free/i.test(name) || /free/i.test(shortId)) {
                models.push({ id: 'opencode/' + shortId, name, provider: 'opencode', free: true });
            }
        } catch (e) {}
        i = j + 1;
    }
    return models;
}

function listOpenCodeFreeModels() {
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
                resolve(parseOpenCodeModelsVerbose(out));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// ===== MONTA O PROMPT DO OPEncode COM MODO E HISTÓRICO =====
function buildOpenCodePrompt(message, mode, history) {
    const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.cowork;
    const historyText = (history && history.length)
        ? history.slice(-15).map(h => `- ${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(h.content || '').slice(0, 800)}`).join('\n')
        : '(sem histórico)';

    return `Você é o Aedificator Codex IDE, um assistente de desenvolvimento prático que opera no diretório atual do projeto.

MODO ATIVO: ${modeInstruction}

SOLICITAÇÃO DO USUÁRIO: "${message}"

HISTÓRICO DA CONVERSA:
${historyText}

Execute a solicitação no diretório do projeto seguindo estas REGRAS:
- Se o pedido for uma pergunta, análise ou opinião, APENAS responda sem alterar nenhum arquivo.
- Só crie/modifique/delete arquivos se o usuário pedir EXPLICITAMENTE.
- NUNCA faça mudanças drásticas (refatorações grandes, reescritas completas, reorganização) sem o usuário pedir explicitamente. Prefira alterações mínimas.
- SEJA CONCISO: responda de forma curta e direta. Nada de explicações longas, listas extensas ou repetições. Vá direto ao ponto.`;
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

async function callOpenCode(prompt, onChunk, signal, model) {
    const binary = resolveOpenCodeBinary();
    ensureOpenCodeConfig();
    ensureOpenCodeAuth(config.opencode.apiKey);
    const args = ['run', '--format', 'json'];
    let useModel = model || OPENCODE_DEFAULT_MODEL;
    if (!useModel.startsWith('opencode/')) {
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
                    if (event.type === 'text' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
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
                                }
                            }
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
            const msg = d.toString();
            if (msg.trim()) console.log(`[opencode stderr] ${msg.slice(0, 500)}`);
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
                resolve(fullText.trim());
            } else {
                reject(new Error(`opencode terminou com código ${code} sem resposta.`));
            }
        });
        if (signal) {
            signal.addEventListener('abort', () => {
                try { child.kill(); } catch (e) {}
            }, { once: true });
        }
    });
}

async function callDeepSeek(prompt, onChunk, signal) {
    const apiKey = config.deepseek.apiKey;
    if (!apiKey) {
        throw new Error('Chave API DeepSeek não configurada!');
    }

    const url = 'https://api.deepseek.com/v1/chat/completions';
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: config.deepseek.model || 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }],
            stream: true
        })
    }, 120000, signal);

    if (!response.ok) {
        throw new Error(`Erro na API DeepSeek: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    while (true) {
        if (signal && signal.aborted) break;
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
                    if (content) {
                        fullResponse += content;
                        if (onChunk) onChunk(content);
                    }
                } catch (e) {}
            }
        }
    }
    return fullResponse;
}

async function callAI(provider, prompt, onChunk, signal) {
    if (provider === 'gemini') {
        return await callGemini(prompt, onChunk, signal);
    } else if (provider === 'deepseek') {
        return await callDeepSeek(prompt, onChunk, signal);
    } else if (provider === 'opencode') {
        return await callOpenCode(prompt, onChunk, signal);
    } else if (provider && provider.startsWith('opencode/')) {
        const model = provider.slice('opencode/'.length);
        return await callOpenCode(prompt, onChunk, signal, model);
    } else {
        throw new Error(`Provedor ${provider} não suportado`);
    }
}

// =============================================
//  PARSEAR JSON DA RESPOSTA DA IA
// =============================================
function extractJson(text) {
    if (!text) return null;
    const trimmed = text.trim();
    try { return JSON.parse(trimmed); } catch (e) {}

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()); } catch (e) {}
    }

    let depth = 0;
    let start = -1;
    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (trimmed[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try { return JSON.parse(trimmed.slice(start, i + 1)); } catch (e) {}
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
    clarify: 'Modo Esclarecer: NÃO altere nenhum arquivo. Apenas faça perguntas de esclarecimento. Responda com um JSON onde "resumo" contém suas perguntas e "arquivos" é uma lista VAZIA [].',
    code: 'Modo Código: foque exclusivamente em código. Faça apenas as alterações mínimas necessárias e mantenha explicações curtas.',
    acp: 'Modo Arquitetura: foque na arquitetura do sistema. Prefira criar ou atualizar um documento de arquitetura (ex.: ARQUITETURA.md) descrevendo a solução, em vez de alterar código diretamente.'
};

// =============================================
//  ANÁLISE DO PLANO
// =============================================
async function analyzeTask(message, onChunk, signal, mode = 'cowork', history = [], provider = 'gemini') {
    const allFiles = getAllFiles('');
    const fileTree = getFileTree('');
    const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.cowork;

    const historyText = (history && history.length)
        ? history.slice(-15).map(h => `- ${h.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(h.content || '').slice(0, 800)}`).join('\n')
        : '(sem histórico)';

    console.log(`📁 Projeto: ${PROJECT_ROOT}`);
    console.log(`📄 Arquivos no contexto: ${allFiles.length}`);

    const analysisPrompt = `Você é o Aedificator Codex IDE, um assistente de desenvolvimento prático e CUIDADOSO. O código de um projeto é uma arte: respeite a estrutura existente e nunca imponha mudanças sem o usuário decidir.

DIRETÓRIO DO PROJETO: ${PROJECT_ROOT}

ESTRUTURA DO PROJETO:
${fileTree || '(pasta vazia)'}

ARQUIVOS DISPONÍVEIS:
${allFiles.join('\n') || '(nenhum arquivo)'}

SOLICITAÇÃO DO USUÁRIO: "${message}"

MODO ATIVO: ${modeInstruction}

HISTÓRICO DA CONVERSA:
${historyText}

DECIDA O FORMATO DA RESPOSTA CONFORME A SOLICITAÇÃO:

CASO A — SOLICITAÇÃO DE MELHORIA / SUGESTÃO / OPINIÃO (ex.: "existe algo para melhorar?", "o que você sugere?", "tem alguma coisa errada no app?"):
1. Faça uma análise DETALHADA e cuidadosa do projeto como um todo.
2. Proponha várias melhorias RELACIONADAS, ORGANIZADAS por categoria (ex.: usabilidade, desempenho, segurança, manutenção, arquitetura, código limpo).
3. Para CADA sugestão, especifique: titulo (nome curto), descricao (detalhada), impacto ("baixo", "médio" ou "alto") e arquivos (lista dos arquivos que seriam alterados).
4. Cada sugestão deve ser MÍNIMA e LOCALIZADA. NUNCA sugira reescrever o app inteiro nem mudanças drásticas. Se a mudança afetar muitas áreas, quebre em sugestões menores e independentes.
5. Apenas PROPOSTAS — você não altera nada por conta própria; o usuário escolherá o que aplicar, item por item.
6. LIMITE: no máximo 4 sugestões. Cada sugestão altera no máximo 2 arquivos. NUNCA proponha reescrever arquivos que já funcionam — só pequenas melhorias pontuais.

CASO B — PEDIDO EXPLÍCITO DE ALTERAÇÃO (o usuário pediu claramente para criar, corrigir, modificar ou deletar arquivos):
1. Identifique os arquivos que precisam ser criados ou modificados.
2. Para CADA arquivo, especifique: caminho, ação, conteúdo completo e explicação.
3. Faça APENAS o que foi pedido, da forma mais mínima possível.
4. LIMITE: no máximo 5 arquivos no total, apenas os necessários para atender ao pedido.

Responda APENAS com um JSON válido em UM dos formatos abaixo.

FORMATO A (melhorias/sugestões):
{
  "resumo": "MÁXIMO 2-3 frases curtas com a análise geral",
  "sugestoes": [
    {
      "id": "s1",
      "titulo": "Título curto da melhoria",
      "descricao": "MÁXIMO 2 frases",
      "impacto": "baixo",
      "arquivos": [
        { "caminho": "src/index.js", "acao": "modificar", "conteudo": "conteúdo completo do arquivo", "explicacao": "uma frase curta" }
      ]
    }
  ]
}

FORMATO B (alterações diretas):
{
  "resumo": "Resumo curto do que será feito",
  "arquivos": [
    { "caminho": "src/index.js", "acao": "modificar", "conteudo": "conteúdo completo do arquivo", "explicacao": "uma frase curta" }
  ]
}

REGRAS GERAIS:
- SEJA CONCISO E PRECISO: "resumo" com no máximo 2-3 frases. "descricao" com no máximo 2 frases. "explicacao" com uma única frase curta. "titulo" curto (5-8 palavras). Sem introduções longas, sem repetições, sem listar o que não foi pedido.
- REGRA DE OURO: NUNCA faça mudanças drásticas (refatorações grandes, reescritas completas, reorganização de pastas, alterar o app inteiro) sem o usuário pedir EXPLICITAMENTE. O código é uma arte — seja cuidadoso e conservador.
- Perguntas de opinião/análise usam o FORMATO A (sugestoes). O usuário decidirá, uma a uma, o que aplicar.
- Pedidos concretos de alteração usam o FORMATO B e fazem só o que foi pedido.
- Prefira sempre alterações mínimas e localizadas.
- O conteúdo deve ser COMPLETO (o arquivo inteiro)
- Se for criar, inclua todo o conteúdo necessário
- Se for modificar, inclua o arquivo inteiro com as alterações`;

    if (onChunk) onChunk('Assistente', '🔍 Analisando estrutura do projeto...\n');

    const response = await callAI(provider, analysisPrompt, null, signal);

    const plan = extractJson(response);
    if (!plan) {
        throw new Error('Não foi possível interpretar a resposta da IA.');
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
        return plan;
    }

    if (!Array.isArray(plan.arquivos)) {
        throw new Error('Não foi possível interpretar a resposta da IA.');
    }

    for (const arquivo of plan.arquivos) {
        if (!arquivo.caminho) throw new Error('Plano com arquivo sem caminho.');
        if (!['criar', 'modificar', 'deletar'].includes(arquivo.acao)) {
            arquivo.acao = 'modificar';
        }
    }

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

    let modifications = [];
    let cancelled = false;

    for (const arquivo of plan.arquivos) {
        if (signal && signal.aborted) {
            cancelled = true;
            break;
        }

        const { caminho, acao, conteudo, explicacao } = arquivo;

        result += `📄 **${caminho}**\n`;
        result += `   Ação: ${acao}\n`;
        result += `   Explicação: ${explicacao || 'N/A'}\n`;

        if (onChunk) onChunk('Sistema', `📄 ${acao.toUpperCase()}: ${caminho}\n`);

        if (acao === 'criar' || acao === 'modificar') {
            if (onChunk) onChunk('file-status', JSON.stringify([{ file: caminho, action: acao, status: 'editing' }]));

            if (acao === 'modificar') {
                backupRelativePath(caminho);
            }

            const success = writeFileContent(caminho, conteudo);
            const finalStatus = acao === 'criar' ? 'created' : 'modified';
            modifications.push({ file: caminho, action: acao, status: success ? finalStatus : 'normal' });

            if (success) {
                result += `   ✅ ${acao === 'criar' ? 'Criado' : 'Modificado'} com sucesso!\n`;
                if (onChunk) onChunk('Sistema', `✅ ${caminho} ${acao === 'criar' ? 'criado' : 'modificado'}\n`);
            } else {
                result += `   ❌ Erro ao ${acao === 'criar' ? 'criar' : 'modificar'} arquivo!\n`;
                if (onChunk) onChunk('Sistema', `❌ Erro em ${caminho}\n`);
            }
            if (onChunk) onChunk('file-status', JSON.stringify([{ file: caminho, action: acao, status: success ? finalStatus : 'normal' }]));
        } else if (acao === 'deletar') {
            backupRelativePath(caminho);
            if (deleteFileContent(caminho)) {
                result += `   ✅ Deletado com sucesso!\n`;
                if (onChunk) onChunk('Sistema', `🗑️ ${caminho} deletado\n`);
            } else {
                result += `   ⚠️ Arquivo não encontrado (ou fora do projeto) para deletar.\n`;
            }
            modifications.push({ file: caminho, action: acao, status: 'deleted' });
            if (onChunk) onChunk('file-status', JSON.stringify([{ file: caminho, action: acao, status: 'deleted' }]));
        } else {
            result += `   ⚠️ Ação desconhecida: ${acao}\n`;
        }
        result += '\n';
    }

    if (cancelled) {
        result += `\n⏹️ **Tarefa cancelada** (${modifications.length} arquivo(s) processado(s)).\n`;
    } else {
        result += `\n✅ **${modifications.length} arquivo(s) processado(s)!**\n`;
    }
    return result;
}

// =============================================
//  ROTAS DA API
// =============================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

app.post('/api/config', (req, res) => {
    const { geminiKey, deepseekKey, opencodeKey } = req.body;
    if (geminiKey) config.gemini.apiKey = geminiKey;
    if (deepseekKey) config.deepseek.apiKey = deepseekKey;
    if (opencodeKey) {
        config.opencode.apiKey = opencodeKey;
        ensureOpenCodeAuth(opencodeKey);
    }

    try {
        saveConfigToFile();
        res.json({ success: true, message: 'Configuração salva!' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/config/status', (req, res) => {
    res.json({
        gemini: { configured: !!config.gemini.apiKey },
        deepseek: { configured: !!config.deepseek.apiKey },
        opencode: { configured: !!config.opencode.apiKey || !!getOpenCodeAuthKey() }
    });
});

app.get('/api/models/opencode', async (req, res) => {
    try {
        const models = await listOpenCodeFreeModels();
        res.json({ success: true, models });
    } catch (e) {
        res.status(500).json({ error: e.message });
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

// ===== BUSCA NO PROJETO =====
function isBinaryExtension(name) {
    const bin = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'exe', 'dll', 'msi', 'mp3', 'mp4', 'woff', 'woff2', 'ttf', 'otf', 'node']);
    const ext = (name.split('.').pop() || '').toLowerCase();
    return bin.has(ext);
}

app.post('/api/search', (req, res) => {
    const { query, inContent } = req.body;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'Busca vazia' });

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
            const nameMatch = entry.name.toLowerCase().includes(q);
            let matches = [];

            if (inContent) {
                const full = path.join(dir, entry.name);
                try {
                    if (fs.statSync(full).size <= 2 * 1024 * 1024 && !isBinaryExtension(entry.name)) {
                        const content = fs.readFileSync(full, 'utf-8');
                        if (!content.includes('\u0000')) {
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length && matches.length < 20; i++) {
                                if (lines[i].toLowerCase().includes(q)) {
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

// ===== IMAGENS =====
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
            resolve({ code, output: out || err });
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
wss.on('connection', (ws, req) => {
    const origin = (req.headers && req.headers.origin) || '';
    if (origin && !isLocalOrigin(origin)) {
        ws.close(1008, 'Origin não permitida');
        return;
    }
    console.log('🔌 Cliente WebSocket conectado');
    let streamController = null;
    let pendingPlan = null;

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            return;
        }

        if (data.type === 'cancel') {
            if (streamController) {
                streamController.abort();
                streamController = null;
                ws.send(JSON.stringify({ type: 'cancelled' }));
            }
            return;
        }

        if (data.type === 'stream') {
            if (BACKEND_TOKEN && data.token !== BACKEND_TOKEN) {
                ws.send(JSON.stringify({ type: 'error', content: '❌ Não autorizado' }));
                ws.close();
                return;
            }

            const { message: task, projectPath, mode, history } = data;

            if (projectPath) {
                setProjectRoot(projectPath);
            }

            streamController = new AbortController();

            const onChunk = (agent, text) => {
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
                ws.send(JSON.stringify({ type: 'chunk', agent: agent || 'Sistema', content: text }));
            };

            try {
                const model = data.model || 'gemini';
                if (model === 'opencode' || (model && model.startsWith('opencode/'))) {
                    const openCodeModel = model === 'opencode' ? null : model.slice('opencode/'.length);
                    if (onChunk) onChunk('Assistente', '🟣 opencode executando...\n');
                    const openPrompt = buildOpenCodePrompt(task, mode, Array.isArray(history) ? history : []);
                    const beforeContents = snapshotProjectContents();
                    const before = snapshotProjectFiles();
                    await callOpenCode(openPrompt, (chunk) => {
                        if (onChunk) onChunk('Assistente', chunk);
                    }, streamController.signal, openCodeModel);
                    const changes = diffSnapshots(before, snapshotProjectFiles());
                    for (const change of changes) {
                        if (change.action === 'modificar' || change.action === 'deletar') {
                            const orig = beforeContents.get(change.file);
                            if (orig !== undefined) {
                                backupFromContent(change.file, orig);
                            }
                        }
                        if (onChunk) onChunk('file-status', JSON.stringify([change]));
                    }
                    ws.send(JSON.stringify({ type: 'refresh' }));
                    ws.send(JSON.stringify({ type: 'done' }));
                    return;
                }

                const plan = await analyzeTask(task, onChunk, streamController.signal, mode, Array.isArray(history) ? history : [], model);
                const planId = crypto.randomBytes(8).toString('hex');
                pendingPlan = { id: planId, plan, controller: streamController };

                const hasSuggestions = Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0;
                const payload = {
                    type: 'approval',
                    planId,
                    total: hasSuggestions
                        ? plan.sugestoes.reduce((n, s) => n + (Array.isArray(s.arquivos) ? s.arquivos.length : 0), 0)
                        : plan.arquivos.length,
                    resumo: plan.resumo || ''
                };
                if (hasSuggestions) {
                    payload.sugestoes = plan.sugestoes.map((s, i) => ({
                        id: s.id || 's' + (i + 1),
                        titulo: s.titulo || 'Sugestão ' + (i + 1),
                        descricao: s.descricao || '',
                        impacto: s.impacto || 'médio',
                        arquivos: (Array.isArray(s.arquivos) ? s.arquivos : []).map(a => ({
                            caminho: a.caminho,
                            acao: a.acao,
                            explicacao: a.explicacao || ''
                        }))
                    }));
                } else {
                    payload.arquivos = plan.arquivos.map(a => ({
                        caminho: a.caminho,
                        acao: a.acao,
                        explicacao: a.explicacao || ''
                    }));
                }
                ws.send(JSON.stringify(payload));
            } catch (error) {
                const cancelled = error && error.name === 'AbortError';
                ws.send(JSON.stringify({
                    type: cancelled ? 'cancelled' : 'error',
                    content: cancelled ? '⏹️ Tarefa cancelada' : `❌ ${error.message}`
                }));
            }
            return;
        }

        if (data.type === 'execute') {
            if (BACKEND_TOKEN && data.token !== BACKEND_TOKEN) {
                ws.send(JSON.stringify({ type: 'error', content: '❌ Não autorizado' }));
                return;
            }
            if (!pendingPlan || data.planId !== pendingPlan.id) {
                ws.send(JSON.stringify({ type: 'error', content: '❌ Plano expirado, envie novamente' }));
                return;
            }

            const { plan, controller } = pendingPlan;
            pendingPlan = null;
            streamController = controller;

            const onChunk = (agent, text) => {
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
                ws.send(JSON.stringify({ type: 'chunk', agent: agent || 'Sistema', content: text }));
            };

            try {
                let filesToExecute;
                if (Array.isArray(plan.sugestoes) && plan.sugestoes.length > 0) {
                    const selected = new Set(Array.isArray(data.selecionadas) ? data.selecionadas : []);
                    filesToExecute = [];
                    for (const s of plan.sugestoes) {
                        if (selected.has(s.id) && Array.isArray(s.arquivos)) {
                            filesToExecute.push(...s.arquivos);
                        }
                    }
                } else {
                    filesToExecute = plan.arquivos || [];
                }
                await executePlan({ resumo: plan.resumo || '', arquivos: filesToExecute }, onChunk, controller.signal);
                ws.send(JSON.stringify({ type: 'done' }));
            } catch (error) {
                const cancelled = error && error.name === 'AbortError';
                ws.send(JSON.stringify({
                    type: cancelled ? 'cancelled' : 'error',
                    content: cancelled ? '⏹️ Tarefa cancelada' : `❌ ${error.message}`
                }));
            } finally {
                streamController = null;
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 Cliente WebSocket desconectado');
        if (streamController) {
            streamController.abort();
            streamController = null;
        }
        pendingPlan = null;
    });
});

module.exports = { app, server, resolveSafePath, extractJson, setProjectRoot, writeFileContent, readFileContent, listBackups, analyzeTask, executePlan, parseJsonC, buildOpenCodePrompt, snapshotProjectFiles, diffSnapshots, parseRemoteUrl, nextVersion, detectRepo, latestVersionTag, runner };

// =============================================
//  INICIAR SERVIDOR (APENAS SE EXECUTADO DIRETO)
// =============================================
if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`✅ Aedificator Codex IDE Backend rodando na porta ${PORT}`);
        console.log(`🔗 http://localhost:${PORT}/api/health`);
        console.log(`📁 Diretório do projeto: ${PROJECT_ROOT}`);
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`❌ Porta ${PORT} já está em uso!`);
        } else {
            console.error('❌ Erro no servidor:', error);
        }
    });

    process.on('uncaughtException', (error) => {
        console.error('❌ Erro não tratado:', error);
    });

    console.log('🏗️ Aedificator Codex IDE Backend inicializando...');
    console.log(`📁 Diretório base: ${PROJECT_ROOT}`);
    console.log('🎯 Modo AUTOMÁTICO - Analisa e altera arquivos automaticamente!');
}
