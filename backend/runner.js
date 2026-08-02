// =============================================
//  RUNNER - execução de comandos e builds
// =============================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_PLATFORMS = new Set(['win', 'mac', 'linux']);
const ALLOWED_ARCHS = new Set(['x64', 'ia32', 'arm64']);
const ALLOWED_FORMATS = new Set(['nsis', 'portable', 'zip', 'dmg', 'pkg', 'AppImage', 'deb', 'snap', 'tar.gz']);

let buildChild = null;

function validateBuildTarget({ platform, arch, format } = {}) {
    const errors = [];
    if (!ALLOWED_PLATFORMS.has(platform)) errors.push(`Plataforma inválida: ${platform}`);
    if (!ALLOWED_ARCHS.has(arch)) errors.push(`Arquitetura inválida: ${arch}`);
    if (!ALLOWED_FORMATS.has(format)) errors.push(`Formato inválido: ${format}`);
    return errors;
}

function resolveBuilderPath(buildCwd) {
    const candidates = [
        path.join(buildCwd, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
        path.join(buildCwd, 'node_modules', 'electron-builder', 'cli.js'),
        path.join(buildCwd, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
}

function runCommand({ command, cwd, onLine, timeoutMs = 300000 }) {
    return new Promise((resolve, reject) => {
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
        let child;
        try {
            child = spawn(shell, args, { cwd, windowsHide: true });
        } catch (e) {
            return reject(e);
        }

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
        }, timeoutMs);

        child.stdout.on('data', (d) => {
            const s = d.toString('utf8');
            stdout += s;
            if (onLine) onLine(s);
        });
        child.stderr.on('data', (d) => {
            const s = d.toString('utf8');
            stderr += s;
            if (onLine) onLine(s);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function isBuildRunning() {
    return !!buildChild;
}

function startBuild({ platform, arch, format, cwd, onLine }) {
    return new Promise((resolve, reject) => {
        if (buildChild) {
            return reject(Object.assign(new Error('Já existe um build em andamento.'), { status: 409 }));
        }

        const errors = validateBuildTarget({ platform, arch, format });
        if (errors.length) {
            return reject(Object.assign(new Error(errors.join('; ')), { status: 400 }));
        }

        const builder = resolveBuilderPath(cwd);
        if (!builder) {
            return reject(new Error('electron-builder não encontrado. Execute "npm install" primeiro.'));
        }

        const args = [];
        if (builder.endsWith('.js')) {
            args.push(builder);
        } else {
            args.push('electron-builder');
        }
        args.push(`--${platform}`, arch);
        if (format !== 'nsis') {
            args.push(`-c.${platform}.target=${format}`);
        }

        let child;
        try {
            child = builder.endsWith('.js')
                ? spawn('node', args, { cwd, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, windowsHide: true })
                : spawn(builder, ['electron-builder', ...args.slice(1)], { cwd, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, shell: process.platform === 'win32', windowsHide: true });
        } catch (e) {
            return reject(e);
        }

        buildChild = child;
        if (onLine) onLine(`🚀 Iniciando build: ${platform}/${arch} (${format})...\n`);

        child.stdout.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });
        child.stderr.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });
        child.on('close', (code) => {
            buildChild = null;
            if (onLine) onLine(code === 0 ? '\n✅ Build concluído!\n' : `\n❌ Build falhou (código ${code}).\n`);
            resolve({ code });
        });
        child.on('error', (err) => {
            buildChild = null;
            if (onLine) onLine(`❌ Erro ao iniciar build: ${err.message}\n`);
            reject(err);
        });
    });
}

function cancelBuild(onLine) {
    if (!buildChild) return false;
    try {
        buildChild.kill();
        buildChild = null;
        if (onLine) onLine('\n⏹️ Build cancelado.\n');
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = {
    runCommand,
    startBuild,
    cancelBuild,
    isBuildRunning,
    validateBuildTarget,
    resolveBuilderPath,
    ALLOWED_PLATFORMS,
    ALLOWED_ARCHS,
    ALLOWED_FORMATS
};
