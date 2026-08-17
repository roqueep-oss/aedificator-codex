# Regras de Ouro — Aedificator Codex

Estas são as regras fundamentais que devem guiar toda construção, criação, correção, alteração e upgrade de código. Siga-as rigorosamente.

## Princípios Fundamentais

### KISS (Keep It Simple, Stupid)
Priorize a simplicidade. Escreva o código mais simples que resolva o problema. Evite complexidade desnecessária, padrões rebuscados ou abstrações prematuras.

### DRY (Don't Repeat Yourself)
Cada pedaço de conhecimento ou lógica deve ter uma representação única no sistema. Se houver código duplicado, abstraia-o em uma função, classe ou módulo reutilizável.

### YAGNI (You Aren't Gonna Need It)
Não implemente funcionalidades pensando no futuro se não precisa delas agora. Escreva apenas o necessário para a demanda atual. Código a menos é melhor que código a mais.

### Boy Scout Rule
Deixe o código mais limpo do que como você o encontrou. Sempre que mexer em um arquivo, faça uma pequena melhoria: renomeie uma variável mal nomeada, extraia uma função, remova código morto, adicione um teste.

## Legibilidade e Organização

### Nomes significativos
Variáveis, funções e classes devem revelar sua intenção. Use nomes claros e descritivos.
- ✅ `calcular_total_imposto()`, `usuario_autenticado`, `MAX_TENTATIVAS_LOGIN`
- ❌ `calc()`, `x`, `data`, `temp`, `obj`

### Funções pequenas e de responsabilidade única
Uma função deve fazer apenas uma coisa, fazê-la bem e ser a única a fazê-la (alinhado ao SRP do SOLID).
- Máximo recomendado: 10-20 linhas por função.
- Se a função faz mais de uma coisa, divida-a.

### Evite comentários óbvios
O código deve ser autoexplicativo. Comentários devem explicar o **porquê** de uma decisão complexa, não **o que** o código está fazendo.
- ❌ `// incrementa i em 1` sobre `i += 1`
- ✅ `// Usa polling em vez de WebSocket porque o firewall do cliente bloqueia conexões persistentes`

## Robustez e Testes

### Tratamento de erros explícito
Nunca ignore exceções ou falhas silenciosas. O código deve prever cenários de falha e tratar erros graciosamente.
- Capture exceções e tome uma ação: log, fallback, retry ou propagação com contexto.
- ❌ `try { ... } catch(e) {}`
- ✅ `try { ... } catch(e) { logger.error("Falha ao processar pedido", { pedidoId, erro: e.message }); throw e; }`

### Escreva testes automáticos
Código perfeito é código testado. Testes unitários e de integração garantem que alterações futuras não quebrem o funcionamento existente.
- Cubra os fluxos críticos com testes automatizados.
- Toda funcionalidade nova deve vir acompanhada de testes.

## Resumo: O que fazer e o que evitar

| ✅ Fazer                                    | ❌ Evitar                                           |
|---------------------------------------------|-----------------------------------------------------|
| Funções pequenas (10-20 linhas)             | Funções gigantescas que fazem múltiplos processos   |
| Nomes claros e autoexplicativos             | Siglas obscuras e nomes de uma única letra          |
| Modularização e baixo acoplamento           | Classes/módulos dependentes de dezenas de outros    |
| Testes unitários cobrindo fluxos críticos   | Entregar código sem validação automatizada          |
| Código simples e direto                     | Over-engineering e padrões desnecessários           |

## Arquitetura do Projeto

```
aedificator-codex/
├── main.js              → Electron main process (janela, spawn do backend)
├── preload.js           → Ponte segura entre renderer e Node.js
│
├── frontend/            → SPA servida pelo Express (vanilla HTML/CSS/JS)
│   ├── index.html       → Layout principal (explorer, editor, chat, modals)
│   ├── script.js        → Toda a lógica do frontend (~8100 linhas)
│   ├── multi-agent.js   → Sessões paralelas de agentes (tabs de chat)
│   ├── style.css        → Temas claro/escuro
│   └── vendor/          → Bibliotecas third-party
│
├── backend/
│   ├── server.js        → Express + WebSocket + AI + agentes (~6900 linhas)
│   ├── analyzer.js      → Indexação de código, parser JS/TS, validação
│   ├── runner.js        → Execução de comandos shell e builds Electron
│   ├── debugger.js      → Debug via CDP (Node, Chrome, Python, Go)
│   ├── remote.js        → SSH remoto (deploy, execução)
│   ├── browser-client.js→ Automação de navegador (Playwright)
│   ├── mcp-client.js    → Model Context Protocol (conexão com servidores MCP)
│   ├── mcp-aedificator-server.js → Servidor MCP expondo ferramentas do Aedificator
│   ├── config.json      → Chaves API criptografadas (AES-256-GCM)
│   └── pricing.json     → Preços dos modelos para tracking de custo
│
├── scripts/
│   ├── publish.js       → Publicação automática (GitHub/GitLab Releases)
│   └── test-e2e.ps1     → Testes end-to-end
│
└── test/
    ├── api.test.js      → Testes de API REST
    └── snapshot.test.js → Testes de snapshot/backup
```

### Fluxo de uma requisição de IA

```
[Chat Input] → sendMessage() → WebSocket {type:'stream', message, provider, mode}
    │
    ▼
[Stream Handler] (server.js ~linha 6090)
    │
    ├─ mode='agent' ─────────→ runAgentLoop() ─→ runAgentLoopGemini/OpenAI/Claude
    │                           │                  (tool-calling nativo, máx 20 iterações)
    │                           ├─ reviewMode ON  → rollback + approval com diff
    │                           └─ reviewMode OFF → aplica direto + diagnósticos
    │
    ├─ provider='opencode' ──→ callOpenCode() (subprocesso CLI)
    │
    ├─ openai/claude ────────→ runAgentLoopOpenAI/Claude()
    │                           ├─ reviewMode ON  → rollback + approval com diff
    │                           └─ reviewMode OFF → aplica direto + diagnósticos
    │
    └─ gemini/deepseek ──────→ [reviewMode ON]  → runExplorationPhase() → analyzeTask() → approval
                               [reviewMode OFF] → runExplorationPhase() → runAgentLoop() → direto
```

### Fluxo de execução de ferramentas no agente

```
runAgentLoopGemini()
    │
    ▼
[Gemini API] ← system prompt + AGENT_TOOLS + mensagens
    │
    ▼ (loop até 20 iterações)
[Resposta] → tool_calls? ──Sim──→ executeAgentTool(name, args)
    │                               │
    │                               ├─ read_file    → resolveSafePath → fs.readFileSync
    │                               ├─ write_file   → resolveSafePath → fs.writeFileSync
    │                               ├─ exec_command → spawn (streaming) ou execSync
    │                               ├─ search_code  → grep nos arquivos do projeto
    │                               └─ ... (30+ ferramentas)
    │                               │
    └─ Não (texto final) ←─────────┘ (resultado enviado de volta ao modelo)

[Pós-execução] → runPostExecutionDiagnostics() → runQuickTest() → done
```

### Convenções de código

- **backend**: `const` por padrão, `let` quando necessário, nunca `var`
- **frontend**: `var` usado em funções legacy (não alterar sem testar), `let`/`const` em código novo
- **WebSocket**: tipo `chunk` para streaming, `file-status` para atualizar explorer, `done` para finalizar
- **Nomes de ferramenta**: snake_case (`read_file`, `exec_command`)
- **Provider keys**: lowercase (`gemini`, `deepseek`, `openai`, `claude`, `opencode`)

### Onde adicionar novas features

| Feature | Arquivo(s) |
|---------|-----------|
| Nova ferramenta do agente | `server.js` → `AGENT_TOOLS` + `executeAgentTool` |
| Novo provedor de IA | `server.js` → `callProvider()` + `runAgentLoopProvider()` + `callAI()` |
| Nova ação no editor | `script.js` → `initMonacoEditor()` (addAction) |
| Novo atalho de teclado | `script.js` → handler global + `monacoEditor.addAction()` |
| Novo modal | `index.html` (HTML/CSS) + `script.js` (lógica) |
| Novo endpoint REST | `server.js` → `app.get/post()` |
| Nova ferramenta MCP | `mcp-aedificator-server.js` |
