const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const PORT = 3999;
const TOKEN = 'test-token-123';
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

function startServer(token) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ide-test-'));
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(PORT),
            BACKEND_TOKEN: token || '',
            PROJECT_ROOT: projectRoot
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
    return { child, projectRoot };
}

// No Windows, matar o processo é imediato mas a pasta ainda pode ficar presa
// (servidor + filhos MCP/opencode segurando handles). Aguarda o exit e tenta
// a limpeza com retry antes de desistir — evita EPERM falso.
function stopServer(child, projectRoot) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
        } else {
            child.kill('SIGKILL');
        }
        let cleaned = false;
        const attempt = (n) => {
            if (cleaned) return;
            try { fs.rmSync(projectRoot, { recursive: true, force: true }); cleaned = true; resolve(); }
            catch (_) { if (n >= 3) resolve(); else setTimeout(() => attempt(n + 1), 300); }
        };
        setTimeout(() => attempt(0), 300);
    });
}

function waitForPort(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tryConnect = () => {
            const sock = net.connect(PORT, '127.0.0.1');
            sock.on('connect', () => {
                sock.destroy();
                resolve();
            });
            sock.on('error', () => {
                sock.destroy();
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('Backend não iniciou a tempo'));
                } else {
                    setTimeout(tryConnect, 200);
                }
            });
        };
        tryConnect();
    });
}

test('health check responde ok', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const res = await fetch(`${BASE}/api/health`);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.status, 'ok');
    } finally {
        stopServer(child, projectRoot);
    }
});

test('autenticação: exige token e aceita token correto', async (t) => {
    const { child, projectRoot } = startServer(TOKEN);
    try {
        await waitForPort();

        const noAuth = await fetch(`${BASE}/api/health`);
        assert.strictEqual(noAuth.status, 401);

        const withAuth = await fetch(`${BASE}/api/health`, {
            headers: { 'Authorization': `Bearer ${TOKEN}` }
        });
        assert.strictEqual(withAuth.status, 200);

        const wrongAuth = await fetch(`${BASE}/api/health`, {
            headers: { 'Authorization': 'Bearer errado' }
        });
        assert.strictEqual(wrongAuth.status, 401);
    } finally {
        stopServer(child, projectRoot);
    }
});

test('explorador lista arquivos do diretório', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        fs.writeFileSync(path.join(projectRoot, 'app.js'), 'console.log(1)');
        fs.mkdirSync(path.join(projectRoot, 'src'));

        const res = await fetch(`${BASE}/api/explorer/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: projectRoot })
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.success);
        const names = data.files.map(f => f.name);
        assert.ok(names.includes('app.js'));
        assert.ok(names.includes('src'));
    } finally {
        stopServer(child, projectRoot);
    }
});

test('explorador lista subpasta por caminho relativo', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        fs.mkdirSync(path.join(projectRoot, 'src'));
        fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'x');

        // inicializa a raiz do projeto
        await fetch(`${BASE}/api/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: projectRoot })
        });

        const res = await fetch(`${BASE}/api/explorer/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'src' })
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.ok(data.success);
        assert.ok(data.files.some(f => f.name === 'app.js'));
    } finally {
        stopServer(child, projectRoot);
    }
});

test('extractJson extrai JSON de respostas com ruído', () => {
    const { extractJson } = require(SERVER_PATH);

    const fenced = '```json\n{"resumo": "x", "arquivos": []}\n```';
    assert.deepStrictEqual(extractJson(fenced), { resumo: 'x', arquivos: [] });

    const noisy = 'Resposta:\n{"arquivos": [1]} fim';
    assert.deepStrictEqual(extractJson(noisy), { arquivos: [1] });

    const plain = '{"a": 1}';
    assert.deepStrictEqual(extractJson(plain), { a: 1 });

    assert.strictEqual(extractJson('sem json'), null);
});

test('resolveSafePath bloqueia path traversal', () => {
    const { resolveSafePath, setProjectRoot } = require(SERVER_PATH);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ide-safe-'));
    try {
        assert.ok(setProjectRoot(projectRoot));
        assert.ok(resolveSafePath('src/app.js'));
        assert.ok(resolveSafePath('arquivo.txt'));
        assert.strictEqual(resolveSafePath('../escape.js'), null);
        assert.strictEqual(resolveSafePath('../../etc/passwd'), null);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('writeFileContent recusa caminho fora do projeto', () => {
    const { writeFileContent, setProjectRoot } = require(SERVER_PATH);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ide-write-'));
    try {
        setProjectRoot(projectRoot);
        assert.strictEqual(writeFileContent('../evil.js', 'x'), false);
        assert.strictEqual(writeFileContent('dentro.js', 'x'), true);
        assert.strictEqual(fs.existsSync(path.join(projectRoot, 'dentro.js')), true);
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('file/read e file/write criam e modificam arquivos', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        await fetch(`${BASE}/api/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: projectRoot })
        });

        const create = await fetch(`${BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'app.js', content: 'const a = 1;' })
        });
        assert.strictEqual(create.status, 200);

        const read = await fetch(`${BASE}/api/file/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'app.js' })
        });
        const readData = await read.json();
        assert.ok(readData.success);
        assert.strictEqual(readData.content, 'const a = 1;');

        const modify = await fetch(`${BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'app.js', content: 'const a = 2;' })
        });
        assert.strictEqual(modify.status, 200);

        const read2 = await fetch(`${BASE}/api/file/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'app.js' })
        });
        assert.strictEqual((await read2.json()).content, 'const a = 2;');
    } finally {
        stopServer(child, projectRoot);
    }
});

test('backup versionado: write gera backups e restore funciona', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        await fetch(`${BASE}/api/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: projectRoot })
        });

        await fetch(`${BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'x.js', content: 'v0' })
        });
        await fetch(`${BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'x.js', content: 'v1' })
        });
        await fetch(`${BASE}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'x.js', content: 'v2' })
        });

        const list = await fetch(`${BASE}/api/backup/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const listData = await list.json();
        assert.ok(listData.success);
        const xBackups = listData.files.filter(f => f.path === 'x.js');
        assert.strictEqual(xBackups.length, 2, 'deve haver 2 backups (modificações v1 e v2)');

        const newest = xBackups[0];
        const restore = await fetch(`${BASE}/api/backup/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: newest.file })
        });
        const restoreData = await restore.json();
        assert.ok(restoreData.success);
        assert.strictEqual(restoreData.path, 'x.js');
        assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'x.js'), 'utf-8'), 'v1');
    } finally {
        stopServer(child, projectRoot);
    }
});

test('search encontra arquivos por nome e conteúdo', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        fs.writeFileSync(path.join(projectRoot, 'readme.md'), 'hello world\nsegunda linha');
        fs.writeFileSync(path.join(projectRoot, 'nota.txt'), 'outro conteúdo');

        const byContent = await fetch(`${BASE}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'hello', inContent: true })
        });
        const contentData = await byContent.json();
        assert.ok(contentData.success);
        const hit = contentData.results.find(r => r.path === 'readme.md');
        assert.ok(hit, 'deve encontrar readme.md pelo conteúdo');
        assert.ok(hit.matches.length >= 1);

        const byName = await fetch(`${BASE}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'nota', inContent: true })
        });
        const nameData = await byName.json();
        assert.ok(nameData.success);
        assert.ok(nameData.results.some(r => r.path === 'nota.txt'), 'deve encontrar nota.txt pelo nome');
    } finally {
        stopServer(child, projectRoot);
    }
});

test('file/image retorna data URL para PNG', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        fs.writeFileSync(path.join(projectRoot, 'pixel.png'), png);

        const res = await fetch(`${BASE}/api/file/image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'pixel.png' })
        });
        const data = await res.json();
        assert.ok(data.success);
        assert.ok(data.dataUrl.startsWith('data:image/png;base64,'));
    } finally {
        stopServer(child, projectRoot);
    }
});

test('run executa comando e retorna saída', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        await fetch(`${BASE}/api/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: projectRoot })
        });

        const res = await fetch(`${BASE}/api/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'echo aedificator-ide-test' })
        });
        const data = await res.json();
        assert.ok(data.success);
        assert.strictEqual(data.code, 0);
        assert.ok(data.output.includes('aedificator-ide-test'));
    } finally {
        stopServer(child, projectRoot);
    }
});

test('parseJsonC remove comentários preservando strings', () => {
    const { parseJsonC } = require(SERVER_PATH);

    const withComments = `{
        // comentário de linha
        "model": "opencode/x", /* bloco */
        "url": "http://x.com//a",
        "small_model": "y" // final
    }`;
    const parsed = JSON.parse(parseJsonC(withComments));
    assert.strictEqual(parsed.model, 'opencode/x');
    assert.strictEqual(parsed.url, 'http://x.com//a');
    assert.strictEqual(parsed.small_model, 'y');
});

test('buildOpenCodePrompt inclui modo e histórico', () => {
    const { buildOpenCodePrompt } = require(SERVER_PATH);

    const prompt = buildOpenCodePrompt('crie x.js', 'code', [
        { role: 'user', content: 'primeira pergunta' },
        { role: 'assistant', content: 'primeira resposta' }
    ]);
    assert.ok(prompt.includes('crie x.js'), 'deve conter a solicitação');
    assert.ok(prompt.includes('Modo Código'), 'deve conter a instrução do modo code');
    assert.ok(prompt.includes('primeira pergunta'), 'deve conter histórico');
    assert.ok(prompt.includes('primeira resposta'), 'deve conter histórico');
});

test('snapshot/diff detecta criar, modificar e deletar', () => {
    const { snapshotProjectFiles, diffSnapshots, setProjectRoot } = require(SERVER_PATH);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ide-snap-'));
    try {
        setProjectRoot(projectRoot);
        fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'v1');
        const before = snapshotProjectFiles();
        assert.ok(before.has('a.txt'), 'snapshot deve conter a.txt');

        fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'v2');
        fs.writeFileSync(path.join(projectRoot, 'b.txt'), 'novo');
        const after = snapshotProjectFiles();

        const changes = diffSnapshots(before, after);
        const byFile = Object.fromEntries(changes.map(c => [c.file, c]));
        assert.strictEqual(byFile['a.txt'].status, 'modified');
        assert.strictEqual(byFile['b.txt'].status, 'created');

        const afterDel = snapshotProjectFiles();
        fs.rmSync(path.join(projectRoot, 'a.txt'));
        const delChanges = diffSnapshots(afterDel, snapshotProjectFiles());
        const del = delChanges.find(c => c.file === 'a.txt');
        assert.ok(del && del.status === 'deleted');
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
});

test('runner.validateBuildTarget aceita alvos válidos e rejeita inválidos', () => {
    const { runner } = require(SERVER_PATH);
    assert.strictEqual(runner.validateBuildTarget({ platform: 'win', arch: 'x64', format: 'nsis' }).length, 0);
    assert.strictEqual(runner.validateBuildTarget({ platform: 'mac', arch: 'arm64', format: 'dmg' }).length, 0);
    assert.ok(runner.validateBuildTarget({ platform: 'todos', arch: 'x64', format: 'nsis' }).length > 0, 'plataforma inválida');
    assert.ok(runner.validateBuildTarget({ platform: 'win', arch: 'ppc', format: 'nsis' }).length > 0, 'arquitetura inválida');
    assert.ok(runner.validateBuildTarget({ platform: 'win', arch: 'x64', format: 'hack' }).length > 0, 'formato inválido');
});

test('build rejeita plataforma inválida com 400', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const res = await fetch(`${BASE}/api/build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform: 'todos', arch: 'x64', format: 'nsis' })
        });
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.ok(!data.success);
        assert.ok(data.error.includes('Plataforma'));
    } finally {
        stopServer(child, projectRoot);
    }
});

test('build/cancel sem build em andamento responde ok', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const res = await fetch(`${BASE}/api/build/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.cancelled, false);
    } finally {
        stopServer(child, projectRoot);
    }
});

test('CORS bloqueia origem externa', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const res = await fetch(`${BASE}/api/health`, {
            headers: { 'Origin': 'http://evil.example.com' }
        });
        assert.ok(!res.headers.get('access-control-allow-origin'), 'não deve liberar CORS para origem externa');
    } finally {
        stopServer(child, projectRoot);
    }
});

test('CORS libera origem localhost', async (t) => {
    const { child, projectRoot } = startServer('');
    try {
        await waitForPort();
        const res = await fetch(`${BASE}/api/health`, {
            headers: { 'Origin': 'http://localhost:3001' }
        });
        assert.ok(res.headers.get('access-control-allow-origin'), 'deve liberar CORS para localhost');
    } finally {
        stopServer(child, projectRoot);
    }
});
