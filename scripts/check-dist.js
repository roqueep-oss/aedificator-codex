// Guard de distribuição: varre os app.asar gerados em dist/ e FALHA se encontrar
// qualquer dado do desenvolvedor que não pode ir para o instalador:
//   - backend/config.json, backend/.env, backend/token_usage.json e logs;
//   - blobs de chave criptografadas (enc:v1:...) ou chaves em claro (sk-, AIza)
//     dentro dos nossos arquivos de código empacotados.
// Uso: node scripts/check-dist.js  (rodado automaticamente após build:win/dist).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Nomes proibidos DENTRO da pasta backend do pacote.
const FORBIDDEN_BASENAMES = new Set(['config.json', '.env', '.env.example', 'token_usage.json']);

// Blob real de chave tem payload base64 considerável após o prefixo 'enc:v1:';
// o literal 'enc:v1:' no código-fonte (sem payload) não casa.
const KEY_CONTENT_RE = /enc:v1:[A-Za-z0-9+/=]{16,}|AIza[0-9A-Za-z_-]{20,}|\bsk-[A-Za-z0-9]{16,}|\bghp_[A-Za-z0-9]{20,}/;

function findAsars(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            findAsars(full, out);
        } else if (ent.name.endsWith('.asar')) {
            out.push(full);
        }
    }
    return out;
}

function segmentsOf(name) {
    return name.replace(/^[/\\]+/, '').split(/[/\\]/).filter(Boolean);
}

function checkAsar(asarPath, asarMod) {
    const problems = [];
    const names = asarMod.listPackage(asarPath);

    for (const rawName of names) {
        const segs = segmentsOf(rawName);
        if (segs.length < 2 || segs[0] !== 'backend') continue;
        const base = segs[segs.length - 1];
        if (FORBIDDEN_BASENAMES.has(base) || base.endsWith('.log')) {
            problems.push(`arquivo sensível empacotado: ${rawName.replace(/^[/\\]+/, '')}`);
        }
    }

    // Varre o conteúdo dos NOSSOS arquivos (backend/*.js|json + raiz) atrás de
    // chaves reais. Ignora node_modules/ e frontend/ (monaco etc.).
    const codeFiles = names.filter((rawName) => {
        const segs = segmentsOf(rawName);
        if (segs.length === 0) return false;
        if (segs[0] === 'node_modules' || segs[0] === 'frontend') return false;
        const base = segs[segs.length - 1];
        if (!/\.(js|json|mjs)$/.test(base)) return false;
        return segs[0] === 'backend' || segs.length === 1; // raiz (main.js, preload.js, opencode.json)
    });

    for (const rawName of codeFiles) {
        try {
            const buf = asarMod.extractFile(asarPath, rawName).toString('utf8');
            if (KEY_CONTENT_RE.test(buf)) {
                problems.push(`possível chave real no arquivo empacotado: ${rawName.replace(/^[/\\]+/, '')}`);
            }
        } catch (e) { /* arquivo não encontrado/dir: ignora */ }
    }
    return problems;
}

function main() {
    let asarMod = null;
    try { asarMod = require('@electron/asar'); } catch (e) {}

    if (!asarMod) {
        console.error('❌ @electron/asar não encontrado. Rode a partir da raiz do projeto com node_modules instalado.');
        process.exit(1);
    }

    const asars = findAsars(DIST, []);
    if (asars.length === 0) {
        console.error(`⚠️ Nenhum app.asar encontrado em ${DIST}. Rode o build antes (npm run build:win).`);
        process.exit(1);
    }

    let failed = false;
    for (const asarPath of asars) {
        const problems = checkAsar(asarPath, asarMod);
        if (problems.length > 0) {
            failed = true;
            console.error(`❌ ${path.relative(ROOT, asarPath)}:`);
            for (const p of problems) console.error(`   - ${p}`);
        } else {
            console.log(`✅ ${path.relative(ROOT, asarPath)}: sem dados do desenvolvedor.`);
        }
    }

    if (failed) {
        console.error('\n❌ O pacote contém chaves/dados do desenvolvedor. NÃO distribua este build.');
        process.exit(1);
    }
    console.log('✅ check-dist: pacote limpo (nenhuma chave do desenvolvedor).');
}

main();
