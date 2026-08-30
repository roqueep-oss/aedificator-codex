# 🏗️ Aedificator Codex IDE

Ferramenta de desenvolvimento assistida por IA que analisa, planeja e aplica alterações em arquivos de um projeto escolhido por você.

## Como rodar

### Opção 1: Duplo clique
- Execute `iniciar-app.bat` (instala dependências, inicia o backend e abre o app no navegador).

### Opção 2: Manual
1. Instale as dependências: `npm install`
2. Inicie o backend: `node backend/server.js`
3. Abra `http://localhost:3001` no navegador (ou abra `frontend/index.html`).

### Opção 3: Electron
- `npm start` abre o app em uma janela do Electron.

## Primeiros passos
1. Abra **⚙️ Configurações → Chaves API** e cadastre a chave de pelo menos um provedor: **Google Gemini**, **DeepSeek**, **OpenAI**, **Anthropic** ou **opencode**.
2. Clique em **📁 Selecionar Pasta** e escolha a pasta raiz do projeto.
3. Digite um comando no chat (ex.: *"Crie um arquivo server.js com Express"*).
4. A IA analisa, monta um **plano** e aguarda sua **aprovação** antes de alterar arquivos (ou, no modo Smart/Auto, executa conforme a classificação do pedido).

## Recursos
- **Explorador de arquivos** com ícones por tipo e cores de status (editando=vermelho, modificado=verde, criado=azul).
- **Editor de arquivos com abas** (clique em um arquivo; salve com `Ctrl+S`).
- **Visualização de imagens** (PNG, JPG, GIF, SVG, etc.).
- **Aprovação de plano** com opção de execução automática (⚡) e **modo 💡 Opções** (o app analisa e apresenta opções para você escolher antes de executar).
- **Backups versionados** antes de cada alteração (até 10 versões por arquivo) — restaure pelo botão ↩️.
- **Snapshots rotulados da pasta** (botão 📸): salve uma versão completa da pasta com um rótulo, liste, veja o diff e restaure quando quiser.
- **Executar comandos** no projeto (ex.: `npm test`, `npm run build`) — barra ▶️ ou `/run <comando>` no chat.
- **Busca** por nome de arquivo, conteúdo (🔍), **busca avançada** com regex/substituição e **busca semântica** (com embeddings).
- **Terminal integrado** (Ctrl+B), **navegador integrado** (🌐) e **live preview HTML**.
- **Test Runner** (🧪): auto-discovery e execução de Jest/pytest/go test/etc.
- **Git**: status, commit, push, pull, branches, merge, stash, diff visual e blame.
- **Debug** (🐛): Node.js, Python, Go e Chrome/Edge (via DevTools Protocol).
- **Docker** (🐳): build, run, stop, logs de containers.
- **SSH Remoto** (🔗): conectar e executar comandos em servidor remoto.
- **Publicação automática**: detecta repositório GitHub/GitLab e publica tags/com um clique (botão 🚀).
- **Agentes de IA**: múltiplos provedores (Gemini, DeepSeek, OpenAI, Claude, opencode), modelo selecionável, contexto de conversa, subagentes paralelos, ferramentas de edição (apply_patch, write_file, search_replace), rollback automático em erros.
- **Modos de trabalho**: Agente, Equipe, Esclarecer, Código e Arquitetura, além dos modos **Smart/Auto** (classificação automática do pedido).
- **Dashboard de custos IA** (📊), **preços por modelo** (💲) e **logs de erro** (📋).
- **Histórico de chat por projeto** e **projetos recentes**.
- **Reconexão automática** do WebSocket com o backend.
- **Tema claro/escuro** (botão ☀️/🌙).
- Exportar e limpar conversa.

## Segurança
- Caminhos são validados (`resolveSafePath`) para impedir *path traversal*.
- Requisições autenticadas por token quando o backend inicia com `BACKEND_TOKEN`.
- Chaves de API criptografadas (AES-256-GCM) em `backend/config.json`.
- Pastas como `node_modules`, `.git`, `dist` são ignoradas no contexto da IA (limite de 500 arquivos).

## Estrutura
```
backend/server.js   Backend Express + WebSocket (porta 3001)
frontend/index.html Interface (HTML + CSS inline)
frontend/script.js  Lógica da interface
main.js             Inicialização do Electron
preload.js          Ponte Electron → página
test/api.test.js    Testes (node --test)
```

## Testes
`npm test` — executa os testes de API (health, auth, explorador, segurança, editor, backup, busca, imagem, comandos).

## Build (Electron)
- Windows: `npm run build:win`
- macOS: `npm run build:mac`
- Linux: `npm run build:linux`

## Publicação automática de membros (GitHub/GitLab)

Ao selecionar uma pasta que é um **repositório Git com remote `origin` apontando para GitHub ou GitLab**, o app **detecta automaticamente** o provedor e habilitado o botão **🚀** na barra superior.

### Como funciona
1. Você seleciona a pasta (`📁 Selecionar Pasta`).
2. O backend lê `git remote -v` e identifica o provedor (**GitHub** ou **GitLab**), o dono (`owner`) e o repositório (`repo`) — inclusive com grupos/namespaces do GitLab e URLs SSH ou HTTPS.
3. O botão **🚀 Publicar Versão** é habilitado; ao clicar, o app abre um modal com:
   - o repositório detectado (badge 🐙 GitHub ou 🦊 GitLab);
   - a **última tag** e a **próxima versão** (semver `vX.Y.Z`);
   - campo opcional de mensagem do commit.
4. Ao confirmar, o app executa **`git add -A` → `git commit` → `git tag -a vX.Y.Z` → `git push --follow-tags`** automaticamente.

### Detalhes
- A próxima versão é calculada incrementando o `patch` da última tag (ex.: `v1.2.0` → `v1.2.1`; sem tag → `v1.0.0`).
- As credenciais de `push` são as já configuradas no seu git local (SSH keys ou credential manager). Não é necessário token.
- Se não houver repositório de GitHub/GitLab, o botão `🚀` fica desabilitado e o modal explica o motivo.

## Publicação oficial de instaladores (GitHub Releases + GitLab Releases)

O app está configurado para publicar instaladores automaticamente no **GitHub** e no **GitLab**.

### Configuração (1x)
1. In `package.json`, edite a seção `repository` e a seção `build.publish`, trocando os placeholders
   `SEU_USUARIO_GITHUB` e `SEU_USUARIO_GITLAB` pelos seus usuários/orgs reais.
2. Crie os tokens de acesso:
   - **GitHub**: token clássico com escopo `repo` — ou fine-grained com permissão `Contents: write` + `Releases`.
   - **GitLab**: token com escopo `api` e/ou `write_repository`.
3. Copie `scripts/.env.example` para `scripts/.env.local` e preencha os tokens
   (ou defina as variáveis de ambiente `GITHUB_TOKEN` e `GITLAB_TOKEN`).

### Configuração totalmente automática

Você não precisa digitar usuários nem editar `build.publish`: o script **detecta o repositório
automaticamente** a partir do `git remote -v` da pasta atual (mesma lógica do botão 🚀 do app).

- `node scripts/publish.js github` (ou `gitlab` / `all`):
  - Detecta o repositório e monta a configuração de publicação sozinho;
  - Usa a credencial salva no **credential manager do Git** (Antigravity/VSCode/GitHub CLI), sem você colar token;
  - Se **não houver repositório**, pergunta a plataforma, **cria o repositório via API**, configura o `remote` e faz o push inicial;
  - Faz o build (Windows x64/ia32 por padrão) e publica a **GitHub Release / GitLab Release** da versão atual.

Exemplos:
```
node scripts/publish.js            # detecta tudo sozinho
node scripts/publish.js github     # força GitHub
node scripts/publish.js github --private   # cria repo privado
node scripts/publish.js all mac    # publica para macOS
node scripts/publish.js all linux  # publica para Linux
```

### Publicar (versões)
Ao rodar um comando, o app publica a versão atual do `package.json` nos serviços configurados:

| Comando | O que faz |
|---------|-----------|
| `npm run publish:github` | Faz build e publica no GitHub Releases |
| `npm run publish:gitlab` | Faz build e publica no GitLab Releases |
| `npm run publish:all` | Publica no GitHub **e** no GitLab |
| `npm run publish:all:mac` / `:linux` | Publica nos dois para macOS/Linux |
| `npm run version:patch` | Incrementa versão (patch) e publica nos dois |
| `npm run version:minor` | Incrementa versão (minor) e publica nos dois |
| `npm run version:major` | Incrementa versão (major) e publica nos dois |

> Dica: `npm version` também cria a tag Git e o commit de versão. Após rodar um comando `version:*`, use `git push` (e `git push --tags`) para enviar a tag/commit ao repositório.

## Assinatura de código (Windows)

Instaladores Windows **sem assinatura** disparam o aviso do **SmartScreen** ("editor desconhecido") e podem ser bloqueados. A assinatura também é **obrigatória** para o auto-update do electron-builder (a opção `win.verifyUpdateCodeSignature` do `package.json` exige binários assinados).

### Como habilitar a assinatura no CI

1. **Adquira um certificado** de assinatura de código (OV ou EV) em uma CA confiável (ex.: DigiCert, Sectigo, GlobalSign, SSL.com). O certificado precisa suportar **SignTool** (formato `.pfx` ou `.p12`).
2. **Converta** o certificado para base64 (uma única linha):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificado.pfx")) | Set-Content "cert_base64.txt" -NoNewline
   ```
3. **Configure os secrets** do repositório GitHub (`Settings → Secrets and variables → Actions`):
   - `WIN_CSC_LINK` — o conteúdo base64 do `.pfx`.
   - `WIN_CSC_KEY_PASSWORD` — a senha do certificado.
4. No próximo build Windows, o workflow `.github/workflows/ci.yml` importa o certificado e o electron-builder assina o instalador. Sem os secrets, o CI continua buildando, mas **registra um aviso** de que o instalador não será assinado.

### Testes locais (instaladores sem assinatura)

Para buildar/testar localmente sem certificado (esperado que o SmartScreen alerte ao instalar):

```
npm run build:win
```

### Publicação e atualizações

- **Instaladores**: publicados via GitHub/GitLab Releases (`scripts/publish.js`). Recomenda-se só publicar **releases oficiais** com builds assinados.
- **Auto-update**: ainda **não** está implementado. Para ativá-lo será necessário adicionar a dependência `electron-updater`, publicar o `latest.yml` e manter `win.verifyUpdateCodeSignature: true` com builds assinados.
