// Regressão: o CLI do opencode lê o auth.json em diretório POR PLATAFORMA
// (Windows: %LOCALAPPDATA%\opencode\Data). Este teste garante que o Aedificator
// grava/lê no mesmo lugar em que o CLI procura.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-ocpaths-'));
const localAppData = path.join(tmp, 'LocalAppData');
const xdgData = path.join(tmp, 'xdg-data');
const xdgConfig = path.join(tmp, 'xdg-config');
process.env.LOCALAPPDATA = localAppData;
process.env.XDG_DATA_HOME = xdgData;
process.env.XDG_CONFIG_HOME = xdgConfig;

const { getOpenCodeDataDir, getOpenCodeConfigDir, ensureOpenCodeAuth, getOpenCodeAuthKey } =
    require(path.join(__dirname, '..', 'backend', 'server.js'));

after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

test('auth.json do opencode é gravado no diretório do CLI (por plataforma)', () => {
    const isWin = process.platform === 'win32';
    const expectedDataDir = isWin
        ? path.join(localAppData, 'opencode', 'Data')
        : path.join(xdgData, 'opencode');

    assert.strictEqual(getOpenCodeDataDir(), expectedDataDir,
        `getOpenCodeDataDir deve apontar para ${expectedDataDir}`);

    // Config global sempre usa XDG_CONFIG_HOME/~/.config (comportamento do CLI)
    assert.strictEqual(getOpenCodeConfigDir(), path.join(xdgConfig, 'opencode'));

    assert.ok(ensureOpenCodeAuth('sk-opencode-teste-123'), 'gravação deve ter sucesso');

    const authFile = path.join(expectedDataDir, 'auth.json');
    assert.ok(fs.existsSync(authFile), `auth.json deve existir em ${authFile}`);
    const saved = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    assert.strictEqual(saved.opencode.key, 'sk-opencode-teste-123');
    assert.strictEqual(getOpenCodeAuthKey(), 'sk-opencode-teste-123', 'leitura deve voltar a chave gravada');
});
