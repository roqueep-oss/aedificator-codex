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

// ===== BOOTSTRAP: cria o repositório remoto automaticamente =====
const readline = require('readline');
const ask = (q) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
});

// Busca credencial já salva no credential manager do Git (ex.: Antigravity/VSCode)
function readStoredToken(provider) {
    const host = provider === 'github' ? 'github.com' : 'gitlab.com';
    const inp = `protocol=https\nhost=${host}\n\n`;
    const proc = spawnSync('git', ['credential', 'fill'], { input: inp, encoding: 'utf-8' });
    const out = (proc.stdout || '');
    let token = '';
    for (const line of out.split(/\r?\n/)) {
        if (/^password=/i.test(line)) token = line.slice('password='.length).trim();
    }
    if (token) console.log(`🔑 Credencial encontrada automaticamente (${host}).`);
    return token || null;
}

async function getUsername(provider, token) {
    let r;
    if (provider === 'github') {
        r = await fetch('https://api.github.com/user', { headers: { Authorization: `token ${token}` } });
        if (!r.ok) throw new Error(`Falha ao autenticar no GitHub (${r.status}): ${(await r.text()).slice(0, 200)}`);
        const j = await r.json();
        return { owner: j.login, id: j.id };
    }
    r = await fetch('https://gitlab.com/api/v4/user', { headers: { 'PRIVATE-TOKEN': token } });
    if (!r.ok) throw new Error(`Falha ao autenticar no GitLab (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return { owner: j.username, id: j.id };
}

async function createGitHubRepo(token, owner, name, isPrivate, description) {
    const body = { name, private: !!isPrivate, description: description || '' };
    const url = `https://api.github.com/${owner ? 'orgs/' + owner + '/repos' : 'user/repos'}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' },
        body: JSON.stringify(body)
    });
    if (!r.ok && r.status !== 422) throw new Error(`Falha ao criar repo GitHub (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return { provider: 'github', owner, repo: name };
}

async function createGitlabRepo(token, name, visibility) {
    const url = `https://gitlab.com/api/v4/projects?name=${encodeURIComponent(name)}&visibility=${visibility}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': token }
    });
    if (!r.ok) throw new Error(`Falha ao criar repo GitLab (${r.status}): ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const owner = j.path_with_namespace.split('/').slice(0, -1).join('/') || j.namespace?.full_path;
    return { provider: 'gitlab', owner, repo: name };
}

async function bootstrapRemote(pkg) {
    const name = pkg.name || path.basename(ROOT);
    console.log(`\n🌱 Não há repositório remoto configurado. Vou criar um para você.`);

    // Detecta a plataforma automaticamente pela credencial do Git; senão pergunta
    let finalProvider = process.argv.includes('github') ? 'github' : process.argv.includes('gitlab') ? 'gitlab' : null;
    if (!finalProvider) {
        const gh = readStoredToken('github');
        if (gh) finalProvider = 'github';
    }
    if (!finalProvider) {
        finalProvider = process.argv[2]?.toLowerCase() === 'gitlab' ? 'gitlab'
            : (await ask('Qual plataforma deseja usar? (github/gitlab): ')).toLowerCase().startsWith('gitl') ? 'gitlab' : 'github';
    }

    const tokenKey = finalProvider === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN';
    let token = process.env[tokenKey] || process.env[finalProvider === 'github' ? 'GH_TOKEN' : 'GITLAB_TOKEN'];
    if (!token) {
        // Tenta ler do credential manager do Git antes de pedir manualmente
        token = readStoredToken(finalProvider);
    }
    if (!token) {
        token = await ask(`Digite seu ${tokenKey} (não será salvo no git): `);
        if (!token) { console.error('❌ Token vazio. Abortando.'); process.exit(1); }
    }
    // Disponibiliza o token para a etapa de publicação (electron-builder)
    process.env[tokenKey] = token;

    let isPrivate = false;
    if (process.argv.includes('--private')) {
        isPrivate = true;
    } else if (process.argv.includes('--public')) {
        isPrivate = false;
    } else if (!process.env.AED_NO_ASK) {
        const privAns = await ask('Repo privado? (s/n, padrão n): ');
        isPrivate = privAns.toLowerCase().startsWith('s');
    }

    const visibility = finalProvider === 'gitlab' ? (isPrivate ? 'private' : 'public') : null;
    const auth = await getUsername(finalProvider, token);

    let info;
    if (finalProvider === 'github') {
        info = await createGitHubRepo(token, null, name, isPrivate, pkg.description);
        info.owner = auth.owner;
    } else {
        info = await createGitlabRepo(token, name, visibility);
    }

    console.log(`\n✅ Repositório criado: ${finalProvider} · ${info.owner}/${info.repo}`);
    console.log(`🔗 Configurando git remote "origin"...`);

    const remoteUrl =
        finalProvider === 'github'
            ? `https://github.com/${info.owner}/${info.repo}.git`
            : `git@gitlab.com:${info.owner}/${info.repo}.git`;

    run(['remote', 'remove', 'origin']);
    const addR = run(['remote', 'add', 'origin', remoteUrl]);
    if (addR.code !== 0) { console.error(`❌ Falha ao configurar remote: ${addR.output}`); process.exit(1); }

    console.log('📤 Fazendo push inicial para a branch atual...');
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).output.trim() || 'master';
    const pushR = run(['push', '-u', 'origin', branch]);
    if (pushR.code !== 0) {
        console.error(`❌ Falha no push: ${pushR.output}\n   Dica: configure o auth (gh auth login / git credential) e tente de novo.`);
        process.exit(1);
    }
    console.log('🔧 Salvando origin em package.json.build.publish...');

    return { isRepo: true, provider: finalProvider, owner: info.owner, repo: info.repo, remoteUrl };
}

// ===== TOKENS =====
async function main() {
const target = (process.argv[2] || 'all').toLowerCase();
const platformArg = (process.argv[3] || '').toLowerCase();
const isFlag = (arg) => /^--/.test(arg);
const platform = !isFlag(platformArg) && platformArg ? platformArg : (process.platform === 'win32' ? 'win' : 'linux');

const repo = detectRepo();

if (!repo.isRepo || !repo.provider) {
    const setup = await bootstrapRemote(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')));
    Object.assign(repo, setup);
}

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
const cleanup = () => {
    try { fs.writeFileSync(pkgPath, backupPkg); } catch {}
    try { if (fs.existsSync(tmpPkgPath)) fs.unlinkSync(tmpPkgPath); } catch {}
};
process.on('exit', cleanup);

const pkg = buildPkg;
const neb = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const baseArgs = ['electron-builder', `--${platform}`];

let failed = false;
for (const provider of providers) {
    let requiredToken = provider === 'github' ? process.env.GITHUB_TOKEN : process.env.GITLAB_TOKEN;
    if (!requiredToken) {
        const stored = readStoredToken(provider);
        if (stored) {
            if (provider === 'github') process.env.GITHUB_TOKEN = stored; else process.env.GITLAB_TOKEN = stored;
            requiredToken = stored;
            console.log(`🔑 Usando credencial do Git para ${provider}.`);
        }
    }
    if (!requiredToken) {
        console.error(`❌ ${provider.toUpperCase()}_TOKEN não definida. Pulando ${provider}.`);
        failed = true;
        continue;
    }
    console.log(`\n🚀 Publicando no ${provider.toUpperCase()} (${repo.owner}/${repo.repo}, plataforma: ${platform})...`);
    const cmdArgs = [neb, ...baseArgs, '--publish', 'always'].map(a => /[ ()"]/.test(a) ? `"${a}"` : a).join(' ');
    const result = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmdArgs] : ['-c', cmdArgs], {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
            ...process.env,
            GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
            GITLAB_TOKEN: process.env.GITLAB_TOKEN
        }
    });
    if (result.error) {
        console.error('❌ Erro ao executar builder:', result.error.message);
    }
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
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });