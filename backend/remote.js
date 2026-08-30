// =============================================
//  REMOTE DEV — SSH / DEPLOY
// =============================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let activeConnection = null;

function buildSshArgs(conn) {
    const args = [];
    if (conn.keyFile) args.push('-i', conn.keyFile);
    if (conn.port && conn.port !== 22) args.push('-p', String(conn.port));
    args.push('-o', 'StrictHostKeyChecking=no');
    args.push('-o', 'UserKnownHostsFile=NUL');
    args.push('-o', 'ConnectTimeout=10');
    return args;
}

function execRemote(command, onOutput) {
    return new Promise((resolve, reject) => {
        if (!activeConnection) return reject(new Error('Nenhuma conexão remota ativa'));
        const { host, user } = activeConnection;
        const args = [...buildSshArgs(activeConnection), `${user}@${host}`, command];
        const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { const t = d.toString(); stdout += t; if (onOutput) onOutput(t); });
        child.stderr.on('data', d => { const t = d.toString(); stderr += t; if (onOutput) onOutput(t); });
        child.on('close', code => {
            if (code !== 0 && stderr && !stdout) reject(new Error(stderr.trim() || 'SSH falhou (código ' + code + ')'));
            else resolve({ stdout, stderr, code });
        });
        child.on('error', e => reject(e));
    });
}

function execRemoteStream(command, onData) {
    if (!activeConnection) {
        if (onData) onData('Nenhuma conexao remota ativa\n');
        return { kill: () => {} };
    }
    const { host, user } = activeConnection;
    const args = [...buildSshArgs(activeConnection), `${user}@${host}`, command];
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { if (onData) onData(d.toString()); });
    child.stderr.on('data', d => { if (onData) onData(d.toString()); });
    child.on('close', code => { if (onData) onData('\n[SSH encerrado — codigo ' + code + ']\n'); });
    child.on('error', e => { if (onData) onData('Erro SSH: ' + e.message + '\n'); });
    return { kill: () => { try { child.kill(); } catch (e) {} } };
}

function connect(conn) {
    return new Promise((resolve, reject) => {
        if (!conn || !conn.host || !conn.user) return reject(new Error('Host e usuário são obrigatórios'));
        const args = [...buildSshArgs(conn), `${conn.user}@${conn.host}`, 'echo CONNECTED'];
        const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        let output = '';
        child.stdout.on('data', d => output += d.toString());
        child.stderr.on('data', d => output += d.toString());
        child.on('close', code => {
            if (output.includes('CONNECTED')) {
                activeConnection = { host: conn.host, user: conn.user, port: conn.port || 22, keyFile: conn.keyFile || null };
                resolve({ success: true, host: conn.host, user: conn.user });
            } else {
                reject(new Error(output.trim() || 'Falha na autenticação SSH (código ' + code + ')'));
            }
        });
        child.on('error', e => reject(new Error('ssh não encontrado. Instale o OpenSSH Client.')));
    });
}

function disconnect() {
    activeConnection = null;
    return { success: true };
}

function getStatus() {
    return activeConnection ? { connected: true, host: activeConnection.host, user: activeConnection.user } : { connected: false };
}

async function listDir(remotePath) {
    const result = await execRemote('ls -la "' + (remotePath || '.') + '"');
    const entries = [];
    const lines = result.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
        if (line.startsWith('total ')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const perms = parts[0];
        const name = parts.slice(8).join(' ');
        if (name === '.' || name === '..') continue;
        entries.push({
            name,
            isDirectory: perms.startsWith('d'),
            size: parseInt(parts[4]) || 0,
            modified: parts[5] + ' ' + parts[6] + ' ' + parts[7],
            permissions: perms
        });
    }
    return { success: true, path: remotePath || '.', entries };
}

async function uploadFile(localPath, remotePath) {
    if (!activeConnection) throw new Error('Nenhuma conexão remota ativa');
    if (!fs.existsSync(localPath)) throw new Error('Arquivo local não encontrado: ' + localPath);
    const { host, user } = activeConnection;
    const args = [...buildSshArgs(activeConnection)];
    return new Promise((resolve, reject) => {
        const child = spawn('scp', [...args, localPath, `${user}@${host}:${remotePath}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stderr.on('data', d => output += d.toString());
        child.on('close', code => {
            if (code === 0) resolve({ success: true, local: localPath, remote: remotePath });
            else reject(new Error(output.trim() || 'SCP falhou (código ' + code + ')'));
        });
        child.on('error', e => reject(new Error('scp não encontrado. Instale o OpenSSH Client.')));
    });
}

async function downloadFile(remotePath, localPath) {
    if (!activeConnection) throw new Error('Nenhuma conexão remota ativa');
    const { host, user } = activeConnection;
    const args = [...buildSshArgs(activeConnection)];
    return new Promise((resolve, reject) => {
        const localDir = path.dirname(localPath);
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        const child = spawn('scp', [...args, `${user}@${host}:${remotePath}`, localPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stderr.on('data', d => output += d.toString());
        child.on('close', code => {
            if (code === 0) resolve({ success: true, remote: remotePath, local: localPath });
            else reject(new Error(output.trim() || 'SCP falhou (código ' + code + ')'));
        });
        child.on('error', e => reject(new Error('scp não encontrado.')));
    });
}

async function deployProject(remoteDir, localDir) {
    if (!activeConnection) throw new Error('Nenhuma conexão remota ativa');
    if (!localDir) throw new Error('Nenhum projeto local aberto');
    // Use rsync or scp -r
    const { host, user } = activeConnection;
    const args = [...buildSshArgs(activeConnection), '-r', localDir + '/', `${user}@${host}:${remoteDir}/`];
    return new Promise((resolve, reject) => {
        const child = spawn('scp', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stderr.on('data', d => output += d.toString());
        child.on('close', code => {
            if (code === 0) resolve({ success: true, deployed: remoteDir });
            else reject(new Error(output.trim().slice(0, 500) || 'Deploy falhou (código ' + code + ')'));
        });
        child.on('error', e => reject(e));
    });
}

function isConnected() {
    return !!activeConnection;
}

module.exports = {
    connect,
    disconnect,
    getStatus,
    listDir,
    uploadFile,
    downloadFile,
    deployProject,
    execRemote,
    execRemoteStream,
    isConnected
};
