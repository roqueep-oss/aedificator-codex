// =============================================
//  RUNNER - execução de comandos e builds
// =============================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_PLATFORMS = new Set(['win', 'mac', 'linux']);
const ALLOWED_ARCHS = new Set(['x64', 'ia32', 'arm64']);
const ALLOWED_FORMATS = new Set(['nsis', 'portable', 'zip', 'dmg', 'pkg', 'AppImage', 'deb', 'tar.gz', 'dir']);

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

        const currentPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
        const isCrossBuild = currentPlatform !== platform;

        // Cross-build: usa --dir (só empacota, sem instalador nativo)
        const useDir = isCrossBuild;
        const actualFormat = useDir ? 'dir' : format;

        const args = [];
        if (builder.endsWith('.js')) {
            args.push(builder);
        }

        const platformFlag = platform === 'mac' ? '--mac' : platform === 'linux' ? '--linux' : '--win';
        args.push(platformFlag);

        if (arch && arch !== 'x64') {
            const archFlag = arch === 'arm64' ? '--arm64' : arch === 'ia32' ? '--ia32' : '--x64';
            args.push(archFlag);
        } else {
            args.push('--x64');
        }

        if (useDir) {
            args.push('--dir');
        }

        args.push('--config');
        const targetConfig = JSON.stringify({
            [platform]: { target: actualFormat }
        });
        args.push(targetConfig);

        if (onLine) {
            if (isCrossBuild) {
                onLine(`🔀 Build cruzado (${currentPlatform} → ${platform}): gerando pacote portátil\n`);
            }
            onLine(`🚀 Build: ${platform}/${arch} → ${useDir ? 'dir (zip portátil)' : format}\n`);
        }

        let child;
        try {
            const spawnArgs = builder.endsWith('.js') ? args : args;
            child = builder.endsWith('.js')
                ? spawn('node', args, { cwd, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, windowsHide: true })
                : spawn(builder, spawnArgs, { cwd, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, shell: process.platform === 'win32', windowsHide: true });
        } catch (e) {
            return reject(e);
        }

        buildChild = child;

        child.stdout.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });
        child.stderr.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });

        child.on('close', (code) => {
            buildChild = null;
            if (code !== 0) {
                if (onLine) onLine(`\n❌ Build falhou (código ${code}).\n`);
                return resolve({ code });
            }

            // Cross-build: zipa o diretório gerado
            if (isCrossBuild) {
                try {
                    const { execSync } = require('child_process');
                    const distDir = path.join(cwd, 'dist');
                    const platformDirName = platform === 'mac' ? 'mac' : platform === 'linux' ? 'linux-unpacked' : 'win-unpacked';
                    const buildDir = path.join(distDir, platformDirName);

                    if (fs.existsSync(buildDir)) {
                        const zipName = `aedificator-${platform}-${arch}-portable.zip`;
                        const zipPath = path.join(distDir, zipName);
                        if (onLine) onLine(`\n📦 Compactando para ${zipName}...\n`);

                        if (currentPlatform === 'win') {
                            execSync(`powershell -Command "Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${zipPath}' -Force"`, { cwd: distDir, timeout: 120000 });
                        } else {
                            execSync(`cd "${path.dirname(buildDir)}" && zip -r "${zipName}" "${path.basename(buildDir)}"`, { cwd: distDir, timeout: 120000 });
                        }

                        if (fs.existsSync(zipPath)) {
                            const sizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
                            if (onLine) onLine(`✅ Pacote portátil: ${zipName} (${sizeMB} MB)\n`);
                        }
                    }
                } catch (e) {
                    if (onLine) onLine(`⚠️ Não foi possível compactar: ${e.message}\n\n✅ Build concluído (diretório disponível em dist/)\n`);
                    return resolve({ code });
                }
            }

            if (onLine) onLine('\n✅ Build concluído!\n');
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

let shellSession = null;

function startShellSession(cwd, onLine) {
    if (shellSession && !shellSession.killed) {
        return { success: true, message: 'Sessão já ativa' };
    }
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['/q'] : [];
    const child = spawn(shell, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    shellSession = child;
    child.stdout.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });
    child.stderr.on('data', (d) => { if (onLine) onLine(d.toString('utf8')); });
    child.on('close', () => { shellSession = null; if (onLine) onLine('\n[Shell encerrada]\n'); });
    child.on('error', (err) => { shellSession = null; if (onLine) onLine('\n[Erro: ' + err.message + ']\n'); });
    return { success: true, message: 'Sessão iniciada' };
}

function sendToShell(command) {
    if (!shellSession || shellSession.killed) {
        return { success: false, error: 'Nenhuma sessão de shell ativa' };
    }
    shellSession.stdin.write(command + '\n');
    return { success: true };
}

function stopShellSession() {
    if (shellSession && !shellSession.killed) {
        shellSession.kill();
    }
    shellSession = null;
    return { success: true };
}

function isShellRunning() {
    return !!(shellSession && !shellSession.killed);
}

module.exports = {
    runCommand,
    startBuild,
    cancelBuild,
    isBuildRunning,
    validateBuildTarget,
    resolveBuilderPath,
    startShellSession,
    sendToShell,
    stopShellSession,
    isShellRunning,
    ALLOWED_PLATFORMS,
    ALLOWED_ARCHS,
    ALLOWED_FORMATS
};
