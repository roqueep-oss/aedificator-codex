// =============================================
//  AEDIFICATOR CODEX - PUBLICAÇÃO GITHUB + GITLAB
//  Uso: node scripts/publish.js [github|gitlab|all] [win|win32|mac|linux]
//  Detecta automaticamente o repositório a partir do `git remote -v`.
// =============================================

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');

// ===== CARREGA .env.local se existir (opcional) =====
const envLocalPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
    for (const line of fs.readFileSync(envLocalPath, 'utf-8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (key && value && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

const run = (args) => {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
    return { code: r.status, output: (r.stdout || '') + (r.stderr || '') };
};

// ===== DETECÇÃO AUTOMÁTICA DO REPOSITÓRIO (igual ao backend) =====
function parseRemoteUrl(url) {
    if (!url) return null;
    const u = String(url).trim();
    const stripGit = (r) => r.replace(/\.git$/, '').replace(/\/$/, '');
    // https://github.com/gitlab.com/…/owner/repo(.git)
    let m = u.match(/https?:\/\/(github|gitlab)\.com\/([^\/\s]+?)(?:\/(.+?))?\/([^\/\s]+)(?:\.git)?$/i);
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
    // git://
    m = u.match(/^git:\/\/(github|gitlab)\.com\/([^ ]+)$/i);
    if (m) {
        const parts = m[2].replace(/\/$/, '').split('/');
        return { provider: m[1].toLowerCase(), owner: stripGit(parts.slice(0, -1).join('/')), repo: stripGit(parts[parts.length - 1]) };
    }
    return null;
}

function detectRepo() {
    const remotes = run(['remote', '-v']);
    const remoteLine = (remotes.output.split('\n')[0] || '').trim();
    const remoteUrl = remoteLine.replace(/^origin\s+/, '').replace(/\s+\(fetch\)$/, '').trim();
    const isRepo = run(['rev-parse', '--abbrev-ref', 'HEAD']).code === 0;
    const parsed = parseRemoteUrl(remoteUrl);
    return {
        isRepo,
        remoteUrl: remoteUrl || '',
        provider: parsed ? parsed.provider : null,
        owner: parsed ? parsed.owner : null,
        repo: parsed ? parsed.repo : null
    };
}

// ===== TOKENS =====
const target = (process.argv[2] || 'all').toLowerCase();
const platform = (process.argv[3] || (process.platform === 'win32' ? 'win' : 'linux')).toLowerCase();

const repo = detectRepo();

if (!repo.isRepo) {
    console.error('❌ Esta pasta não é um repositório git.\n');
    console.error('   Para publicar você precisa estar dentro de um repositório com remote configurado:');
    console.error('     git init && git commit (ou) selecione uma pasta que já é um projeto clonado.');
    process.exit(1);
}
if (!repo.provider) {
    console.error('❌ Não foi possível identificar o provedor (GitHub/GitLab) no remote:');
    console.error(`   ${repo.remoteUrl}\n`);
    console.error('   Use URLs de https://github.com/... , https://gitlab.com/... , git@github.com:... ou git@gitlab.com:...');
    process.exit(1);
}
if (!repo.owner || !repo.repo) {
    console.error('❌ Estrutura do remote não reconhecida (faltando owner/repo):', repo.remoteUrl);
    process.exit(1);
}

console.log(`\n🔍 Repositório detectado: ${repo.provider} · ${repo.owner}/${repo.repo}`);

// Provedores que devem ser publicados
let providers = target === 'all' ? ['github', 'gitlab'] : [target];
// Mantém apenas os detectados (não tenta publicar onde não há repositório)
providers = providers.filter(p => p === repo.provider);

if (providers.length === 0) {
    console.error(`\n⚠️ O repositório é ${repo.provider}, mas você pediu "${target}". Nada a publicar.`);
    process.exit(0);
}

// Placa dinâmica de publicação (electron-builder usa "build.publish")
const buildPkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const publish = [];
if (repo.provider === 'github') {
    publish.push({ provider: 'github', owner: repo.owner, repo: repo.repo });
}
if (repo.provider === 'gitlab') {
    publish.push({
        provider: 'gitlab',
        owner: repo.owner,
        repo: repo.repo,
        private: false,
        releaseType: 'release'
    });
}
buildPkg.build = buildPkg.build || {};
buildPkg.build.publish = publish;

// Escreve um package.json temporário e restaura ao final
const backupPkg = fs.readFileSync(pkgPath, 'utf-8');
const tmpPkgPath = path.join(os.tmpdir(), `pkg-${Date.now()}.json`);
fs.writeFileSync(tmpPkgPath, JSON.stringify(buildPkg, null, 2));
fs.writeFileSync(pkgPath, JSON.stringify(buildPkg, null, 2));
const cleanup = () => { fs.writeFileSync(pkgPath, backupPkg); fs.unlinkSync(tmpPkgPath); };
process.on('exit', cleanup);

const pkg = buildPkg;
const neb = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const baseArgs = ['electron-builder', `--${platform}`];

let failed = false;
for (const provider of providers) {
    const requiredToken = provider === 'github' ? process.env.GITHUB_TOKEN : process.env.GITLAB_TOKEN;
    if (!requiredToken) {
        console.error(`❌ ${provider.toUpperCase()}_TOKEN não definida. Pulando ${provider}.`);
        failed = true;
        continue;
    }
    console.log(`\n🚀 Publicando no ${provider.toUpperCase()} (${repo.owner}/${repo.repo}, plataforma: ${platform})...`);
    const result = spawnSync(neb, [...baseArgs, '--publish', provider], {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
            ...process.env,
            GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
            GITLAB_TOKEN: process.env.GITLAB_TOKEN
        }
    });
    if (result.status !== 0) {
        console.error(`❌ Falha ao publicar no ${provider}.`);
        failed = true;
    } else {
        console.log(`✅ Publicado no ${provider.toUpperCase()}.`);
    }
}

cleanup();

if (failed) {
    console.error('\n⚠️ Publicação concluída com erros. Verifique os logs acima.');
    process.exit(1);
}
console.log('\n🏁 Publicação concluída com sucesso!');