const WebSocket = require('ws');
const url = 'ws://localhost:3001';
const ws = new WebSocket(url);
ws.on('open', () => {
    ws.send(JSON.stringify({
        type: 'stream',
        message: 'Crie um arquivo teste-oc.txt com o conteúdo "hello opencode"',
        model: 'opencode/deepseek-v4-flash-free',
        mode: 'cowork',
        projectPath: 'C:\\Users\\roque\\OneDrive\\Área de Trabalho\\aedificator-codex',
        token: '',
        history: []
    }));
});
ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'chunk') { process.stdout.write(msg.content); }
    else if (msg.type === 'refresh') console.log('\n[REFRESH]');
    else if (msg.type === 'done') { console.log('\n[DONE]'); process.exit(0); }
    else if (msg.type === 'error') { console.log('\n[ERROR]', msg.content); process.exit(1); }
    else console.log('\n[' + msg.type + ']');
});
ws.on('close', () => { console.log('\n[CLOSED]'); process.exit(0); });
setTimeout(() => { console.log('\n[WS TIMEOUT]'); process.exit(1); }, 120000);
