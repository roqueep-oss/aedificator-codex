// Etapa 2: diagnóstico TypeScript do PROJETO INTEIRO (cross-file). Garante que
// erros em arquivos FECHADOS (quebrados por mudança em outro arquivo) aparecem
// no /api/analyzer/project-errors.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const PORT = 3983;
const TOKEN = 'tsproject-token';
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

function startServer() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-tsproj-'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-tsproj-data-'));
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: { ...process.env, PORT: String(PORT), BACKEND_TOKEN: TOKEN, PROJECT_ROOT: projectRoot, AED_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});
    return { child, projectRoot, dataDir };
}

function stopServer(child, projectRoot, dataDir) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
        } else {
            child.kill('SIGKILL');
        }
        setTimeout(() => {
            for (const dir of [projectRoot, dataDir]) {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
            }
            resolve();
        }, 500);
    });
}

function waitForPort(t = 15000) {
    return new Promise((res, rej) => {
        const s = Date.now();
        const c = () => {
            const sock = net.connect(PORT, '127.0.0.1');
            sock.on('connect', () => { sock.destroy(); res(); });
            sock.on('error', () => { sock.destroy(); if (Date.now() - s > t) rej(new Error('timeout')); else setTimeout(c, 200); });
        };
        c();
    });
}

test('project-errors reporta erro em arquivo FECHADO do projeto TS', async () => {
    const { child, projectRoot, dataDir } = startServer();
    try {
        // dep.ts (fechado) tem erro de tipo: return 1 onde o tipo declara string.
        fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(projectRoot, 'lib', 'dep.ts'),
            'export class Greeter {\n  greet(): string {\n    return 1;\n  }\n}\n', 'utf-8');
        // a.ts usa dep corretamente.
        fs.writeFileSync(path.join(projectRoot, 'a.ts'),
            'import { Greeter } from \'./lib/dep\';\nconst g = new Greeter();\nexport const m = g.greet();\n', 'utf-8');

        await waitForPort();
        const res = await fetch(`http://127.0.0.1:${PORT}/api/analyzer/project-errors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
            body: '{}'
        });
        const body = await res.json();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.success, true);

        const depErr = (body.errors || []).find((e) => e.file === 'lib/dep.ts');
        assert.ok(depErr, 'deve reportar o erro do arquivo lib/dep.ts (fechado)');
        assert.strictEqual(depErr.line, 3);
        assert.match(depErr.message, /string|number/i);
        assert.strictEqual(depErr.severity, 'error');
    } finally {
        await stopServer(child, projectRoot, dataDir);
    }
});
