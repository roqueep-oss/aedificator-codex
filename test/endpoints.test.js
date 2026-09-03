const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const PORT = 3991;
const TOKEN = 'endpoints-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

let child;
let projectRoot;

function startServer() {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-endpoints-'));
    child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(PORT), BACKEND_TOKEN: TOKEN, PROJECT_ROOT: projectRoot },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
}

function stopServer() {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
        } else {
            child.kill('SIGKILL');
        }
        const attempt = (n) => {
            try { fs.rmSync(projectRoot, { recursive: true, force: true }); resolve(); }
            catch (e) { if (n >= 3) resolve(); else setTimeout(() => attempt(n + 1), 300); }
        };
        setTimeout(() => attempt(0), 300);
    });
}

function waitForPort(t = 15000) {
    return new Promise((res, rej) => {
        const s = Date.now();
        const tryc = () => {
            const sock = net.connect(PORT, '127.0.0.1');
            sock.on('connect', () => { sock.destroy(); res(); });
            sock.on('error', () => { sock.destroy(); if (Date.now() - s > t) rej(new Error('timeout')); else setTimeout(tryc, 200); });
        };
        tryc();
    });
}

async function api(method, url, body) {
    const res = await fetch(BASE + url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

const get = (url) => api('GET', url);
const post = (url, body) => api('POST', url, body);

// Helpers de arquivo dentro do projeto de teste
function writeRaw(relPath, content) {
    const full = path.join(projectRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
}
function readRaw(relPath) {
    return fs.readFileSync(path.join(projectRoot, relPath), 'utf-8');
}
function existsRaw(relPath) {
    return fs.existsSync(path.join(projectRoot, relPath));
}

before(async () => {
    startServer();
    await waitForPort();
});

after(async () => {
    await stopServer();
});

// ===== CONFIG (apenas leitura, sem mutar config.json real) =====
test('config/get e config/status não expõem chaves reais', async () => {
    const r = await get('/api/config/get');
    assert.strictEqual(r.status, 200);
    for (const p of ['gemini', 'deepseek', 'opencode', 'openai', 'claude']) {
        assert.ok(typeof r.body[p] === 'string', `${p} deve ser string mascarada`);
        assert.ok(r.body[p] === '' || r.body[p] === '********', `${p} não pode vazar chave`);
    }

    const s = await get('/api/config/status');
    assert.strictEqual(s.status, 200);
    for (const p of ['gemini', 'deepseek', 'opencode', 'openai', 'claude']) {
        assert.ok('configured' in s.body[p], `${p}.configured deve existir`);
        assert.strictEqual(typeof s.body[p].configured, 'boolean');
    }
});

test('config/permissions expõe estrutura de permissões', async () => {
    const r = await get('/api/config/permissions');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.ok(Array.isArray(r.body.ask), 'ask deve ser array');
    assert.strictEqual(typeof r.body.grants, 'object');
});

// ===== USAGE E PRICING =====
test('usage responde agregado e por provedor/modelo', async () => {
    const all = await get('/api/usage');
    assert.strictEqual(all.status, 200);
    assert.ok('providers' in all.body, 'usage global deve ter providers');

    const prov = await get('/api/usage?provider=gemini');
    assert.strictEqual(prov.status, 200);
    assert.strictEqual(prov.body.provider, 'gemini');
    assert.ok(prov.body.tokens, 'deve retornar tokens');
});

test('usage/monthly devolve meses, custo BRL e provedores', async () => {
    const r = await get('/api/usage/monthly');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.months), 'months deve ser array');
    assert.strictEqual(typeof r.body.total_brl, 'number');
    assert.strictEqual(typeof r.body.providers, 'object');
});

test('pricing expõe câmbio e preços por provedor', async () => {
    const r = await get('/api/pricing');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.body.usdBrl, 'number');
    for (const p of ['deepseek', 'gemini', 'openai', 'claude', 'opencode']) {
        assert.ok(r.body.prices[p], `preço de ${p} deve existir`);
    }
});

// ===== CICLO DE VIDA REST DE ARQUIVOS =====
test('file CRUD via REST: create, write, read, stat', async () => {
    // create
    let r = await post('/api/file/create', { path: 'alfa.txt' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);

    // read vazio
    r = await post('/api/file/read', { path: 'alfa.txt' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.content, '');

    // write
    r = await post('/api/file/write', { path: 'alfa.txt', content: 'conteúdo A' });
    assert.strictEqual(r.status, 200);

    // read
    r = await post('/api/file/read', { path: 'alfa.txt' });
    assert.strictEqual(r.body.content, 'conteúdo A');
    assert.strictEqual(r.body.name, 'alfa.txt');

    // stat
    r = await post('/api/file/stat', { path: 'alfa.txt' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.isDirectory, false);
    assert.strictEqual(r.body.size, Buffer.byteLength('conteúdo A', 'utf-8'));
});

test('file mkdir, rename e move funcionam e erros retornam status corretos', async () => {
    let r = await post('/api/file/mkdir', { path: 'pasta' });
    assert.strictEqual(r.status, 200);

    // criar duplicado → 409
    r = await post('/api/file/create', { path: 'alfa.txt' });
    assert.strictEqual(r.status, 409);

    // mkdir duplicado → 409
    r = await post('/api/file/mkdir', { path: 'pasta' });
    assert.strictEqual(r.status, 409);

    // rename
    r = await post('/api/file/rename', { path: 'alfa.txt', newPath: 'pasta/alfa.txt' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(existsRaw('alfa.txt'), false);
    assert.strictEqual(existsRaw('pasta/alfa.txt'), true);

    // move
    r = await post('/api/file/move', { path: 'pasta/alfa.txt', newPath: 'beta.txt' });
    assert.strictEqual(r.status, 200);
    assert.ok(!existsRaw('pasta/alfa.txt') && existsRaw('beta.txt'), 'move deve transferir o arquivo');

    // rename de arquivo inexistente → 404
    r = await post('/api/file/rename', { path: 'ghost.txt', newPath: 'x.txt' });
    assert.strictEqual(r.status, 404);

    // delete
    r = await post('/api/file/delete', { path: 'beta.txt' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(existsRaw('beta.txt'), false);

    // leitura de inexistente → 404
    r = await post('/api/file/read', { path: 'beta.txt' });
    assert.strictEqual(r.status, 404);

    // delete de inexistente → 404
    r = await post('/api/file/delete', { path: 'beta.txt' });
    assert.strictEqual(r.status, 404);
});

test('file REST bloqueia path traversal', async () => {
    let r = await post('/api/file/write', { path: '../escape.txt', content: 'x' });
    assert.strictEqual(r.status, 400);

    r = await post('/api/file/read', { path: '../../etc/passwd' });
    assert.strictEqual(r.status, 400);

    r = await post('/api/file/delete', { path: '../../../x' });
    assert.strictEqual(r.status, 400);
});

// ===== BACKUP / RESTAURAR =====
test('backup é criado ao sobrescrever e pode ser restaurado via REST', async () => {
    await post('/api/file/write', { path: 'bkp.txt', content: 'versao1' });
    await post('/api/file/write', { path: 'bkp.txt', content: 'versao2' });
    assert.strictEqual(readRaw('bkp.txt'), 'versao2');

    let r = await post('/api/backup/list', {});
    assert.strictEqual(r.status, 200);
    const backupFile = (r.body.files || []).find((f) => /^bkp\.txt\.\d+$/.test(f.file));
    assert.ok(backupFile, 'deve existir backup de bkp.txt');
    const backupName = backupFile.file;
    assert.strictEqual(readRaw('.aedificator-codex-ide-backup/' + backupName), 'versao1');

    r = await post('/api/backup/restore', { file: backupName });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(readRaw('bkp.txt'), 'versao1', 'restore deve trazer a versão anterior');

    r = await post('/api/backup/restore', { file: 'inexistente.txt.123' });
    assert.strictEqual(r.status, 404);
});

// ===== BUSCA E SUBSTITUIÇÃO =====
test('search encontra texto em conteúdo (case-insensitive, regex e case-sensitive)', async () => {
    writeRaw('busca.js', 'const alpha = 1;\nconsole.log(ALPHA);\n');
    writeRaw('busca2.txt', 'alpha minusculo aqui');

    // case-insensitive padrão
    let r = await post('/api/search', { query: 'alpha', inContent: true });
    assert.strictEqual(r.status, 200);
    const paths = r.body.results.map((x) => x.path);
    assert.ok(paths.includes('busca.js'), 'deve achar busca.js');
    assert.ok(paths.includes('busca2.txt'), 'deve achar busca2.txt');

    // case-sensitive
    r = await post('/api/search', { query: 'ALPHA', caseSensitive: true, inContent: true });
    const cs = r.body.results.map((x) => x.path);
    assert.ok(cs.includes('busca.js') && !cs.includes('busca2.txt'), 'case-sensitive deve filtrar');

    // regex
    r = await post('/api/search', { query: 'alp[a-z]+', useRegex: true, inContent: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.results.length >= 2, true, 'regex deve achar os dois arquivos');

    // busca vazia → 400
    r = await post('/api/search', { query: '  ', inContent: true });
    assert.strictEqual(r.status, 400);
});

test('replace substitui globalmente, versiona e preview não altera', async () => {
    writeRaw('troca.txt', 'x AAA y aaa z');

    // preview primeiro (não altera nada)
    let r = await post('/api/replace/preview', { search: 'aaa', replace: 'BBB' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.results.some((x) => x.file === 'troca.txt'), 'preview deve listar troca.txt');
    assert.strictEqual(readRaw('troca.txt'), 'x AAA y aaa z', 'preview não pode alterar o arquivo');

    // aplica a substituição
    r = await post('/api/replace', { search: 'aaa', replace: 'BBB' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.replaced >= 2, 'deve substituir AAA e aaa');
    assert.strictEqual(readRaw('troca.txt'), 'x BBB y BBB z');

    // gera backup da versão original
    const backups = await post('/api/backup/list', {});
    assert.ok(backups.body.files.some((f) => /^troca\.txt\.\d+$/.test(f.file)), 'deve haver backup de troca.txt');
});

// ===== ANALYZER =====
test('analyzer/validate valida JS válido e acusa erro de sintaxe', async () => {
    let r = await post('/api/analyzer/validate', { code: 'const x = 1;\nconsole.log(x);', file: 'valid.js' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.valid, true, 'código válido');
    assert.strictEqual(r.body.filePath, 'valid.js');

    r = await post('/api/analyzer/validate', { code: 'const x = ;', file: 'broken.js' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.valid, false, 'código com erro de sintaxe');

    // sem código → 400
    r = await post('/api/analyzer/validate', { file: 'solo.js' });
    assert.strictEqual(r.status, 400);
});

// ===== TASKS E KEYBINDINGS (por projeto) =====
test('tasks salvam e listam por projeto', async () => {
    let r = await post('/api/tasks/list', {});
    assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual(r.body.tasks, []);

    r = await post('/api/tasks/save', { tasks: [{ id: 1, title: 'build', done: false }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);

    r = await post('/api/tasks/list', {});
    assert.strictEqual(r.body.tasks.length, 1);
    assert.strictEqual(r.body.tasks[0].title, 'build');

    // payload inválido → 400
    r = await post('/api/tasks/save', { tasks: 'nao-array' });
    assert.strictEqual(r.status, 400);
});

test('keybindings salvam e listam por projeto', async () => {
    let r = await post('/api/keybindings/list', {});
    assert.strictEqual(r.body.success, true);
    assert.deepStrictEqual(r.body.bindings, []);

    r = await post('/api/keybindings/save', { bindings: [{ action: 'save', keys: 'Ctrl+S' }] });
    assert.strictEqual(r.status, 200);

    r = await post('/api/keybindings/list', {});
    assert.strictEqual(r.body.bindings.length, 1);
    assert.strictEqual(r.body.bindings[0].keys, 'Ctrl+S');

    r = await post('/api/keybindings/save', { bindings: 'invalido' });
    assert.strictEqual(r.status, 400);
});

// ===== SETTINGS EXPORT/IMPORT =====
test('settings export seguido de import faz round-trip', async () => {
    // sem corpo → 400
    let r = await post('/api/settings/export', {});
    assert.strictEqual(r.status, 400);

    r = await post('/api/settings/export', { settings: { theme: 'dark', autosave: true } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);

    r = await post('/api/settings/import', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.settings.theme, 'dark');
    assert.strictEqual(r.body.settings.autosave, true);
    assert.ok(r.body.settings.exportedAt, 'export deve carimbar exportedAt');
});

// ===== PROJECT SUMMARY E RULES =====
test('project/summary conta arquivos e detecta linguagens', async () => {
    const r = await post('/api/project/summary', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.projectRoot, projectRoot);
    assert.ok(r.body.totalFiles >= 1, 'deve contar arquivos criados');
    assert.ok(r.body.languages['.txt'] >= 1, 'deve detectar extensão .txt');
    assert.strictEqual(typeof r.body.name, 'string');
});

test('project rules: GET retorna template padrão e POST persiste', async () => {
    let r = await get('/api/project/rules');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.exists, 'regras não criadas ainda');
    assert.match(r.body.content, /Regras do Projeto/);

    r = await post('/api/project/rules', { content: 'regras customizadas de teste' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);

    r = await get('/api/project/rules');
    assert.strictEqual(r.body.exists, true);
    assert.match(r.body.content, /regras customizadas de teste/);
});

// ===== UNDO/REDO (via REST, estado vazio) =====
test('undo/redo via REST respondem sem estado acumulado', async () => {
    let r = await post('/api/undo/status', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.canUndo, false);
    assert.strictEqual(r.body.canRedo, false);

    r = await post('/api/undo', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, false, 'sem stack, undo deve responder success:false');

    r = await post('/api/redo', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, false, 'sem stack, redo deve responder success:false');
});
