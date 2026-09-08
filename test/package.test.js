// Regressão: garante que (1) o empacotamento NUNCA inclui dados sensíveis do
// desenvolvedor nem duplicações pesadas e (2) o backend grava config/dados no
// diretório informado por AED_DATA_DIR (userData no app empacotado), não dentro
// do código/asar.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const pkg = require('../package.json');
const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');

test('empacotamento exclui arquivos sensíveis e duplicações', () => {
    const files = (pkg.build.files || []).join('\n');

    // NUNCA empacotar chaves/logs/dados do desenvolvedor
    for (const item of [
        '!backend/config.json',
        '!backend/.env',
        '!backend/token_usage.json',
        '!backend/**/*.log',
        '!**/.env'
    ]) {
        assert.ok(files.includes(item), `build.files deve excluir "${item}"`);
    }

    // Sem duplicação de monaco (cópia vendor é legacy; só o /node_modules é usado)
    assert.ok(files.includes('!frontend/vendor/monaco/**'), 'deve excluir frontend/vendor/monaco');
    assert.ok(files.includes('!node_modules/monaco-editor/esm/**'), 'deve excluir monaco esm');

    // opencode-ai vira só binário via extraResources (não duplica no asar)
    assert.ok(!pkg.dependencies['opencode-ai'], 'opencode-ai deve ser devDependency');
    assert.ok(pkg.devDependencies['opencode-ai'], 'opencode-ai deve estar em devDependencies');

    // monaco-editor é carregado pelo frontend via /node_modules (servido pelo
    // Express), então precisa estar nas dependências de PRODUÇÃO.
    assert.ok(pkg.dependencies['monaco-editor'], 'monaco-editor deve ser dependency (servido via /node_modules)');

    // electron-updater (auto-update) é dependência de produção
    assert.ok(pkg.dependencies['electron-updater'], 'electron-updater deve ser dependency');

    // asarUnpack do monaco removido (servido via HTTP, funciona de dentro do asar)
    const asarUnpack = JSON.stringify(pkg.build.asarUnpack || []);
    assert.ok(!asarUnpack.includes('monaco-editor'), 'asarUnpack não deve conter monaco-editor');

    // Instaladores ainda são unsigned: verificação de assinatura no auto-update
    // precisa estar desligada até haver certificado configurado.
    assert.strictEqual(pkg.build.win && pkg.build.win.verifyUpdateCodeSignature, false,
        'verifyUpdateCodeSignature deve ser false enquanto não há assinatura');
});

test('backend grava config e dados em AED_DATA_DIR (não no código)', async () => {
    const PORT = 3987;
    const TOKEN = 'package-test-token';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-pkg-data-'));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-pkg-project-'));

    const child = spawn(process.execPath, [SERVER_PATH], {
        env: {
            ...process.env,
            PORT: String(PORT),
            BACKEND_TOKEN: TOKEN,
            PROJECT_ROOT: projectRoot,
            AED_DATA_DIR: dataDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {});

    try {
        await new Promise((resolve, reject) => {
            const start = Date.now();
            const tryConnect = () => {
                const sock = net.connect(PORT, '127.0.0.1');
                sock.on('connect', () => { sock.destroy(); resolve(); });
                sock.on('error', () => {
                    sock.destroy();
                    if (Date.now() - start > 15000) reject(new Error('backend não iniciou'));
                    else setTimeout(tryConnect, 200);
                });
            };
            tryConnect();
        });

        // Força uma gravação real de config (mesmo caminho do smoke test).
        const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
            body: JSON.stringify({ deepseekModel: 'deepseek-v4-pro' })
        });
        assert.strictEqual(res.status, 200);

        // config.json deve nascer em AED_DATA_DIR (e não dentro de backend/)
        assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), 'config.json deve ser gravado em AED_DATA_DIR');

        // pricing.json (estático, empacotado) deve ser semeado no diretório gravável
        assert.ok(fs.existsSync(path.join(dataDir, 'pricing.json')), 'pricing.json deve ser copiado para AED_DATA_DIR');

        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
        assert.strictEqual(saved.deepseek.model, 'deepseek-v4-pro', 'config salvo deve refletir a alteração');
    } finally {
        const kill = () => {
            if (process.platform === 'win32') {
                try { require('child_process').execSync(`taskkill /F /PID ${child.pid} /T`, { stdio: 'ignore' }); } catch (_) {}
            } else {
                child.kill('SIGKILL');
            }
        };
        kill();
        setTimeout(() => {
            try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
            try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch (_) {}
        }, 400);
    }
});
