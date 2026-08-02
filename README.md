# 🏗️ Aedificator Codex

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
1. Clique em **🔑 Chave** e cadastre sua chave da API Gemini (ou DeepSeek).
2. Clique em **📁 Selecionar Pasta** e escolha a pasta raiz do projeto.
3. Digite um comando no chat (ex.: *"Crie um arquivo server.js com Express"*).
4. A IA analisa, monta um **plano** e aguarda sua **aprovação** antes de alterar arquivos.

## Recursos
- **Explorador de arquivos** com ícones por tipo e cores de status (editando=vermelho, modificado=verde, criado=azul).
- **Editor de arquivos com abas** (clique em um arquivo; salve com `Ctrl+S`).
- **Visualização de imagens** (PNG, JPG, GIF, SVG, etc.).
- **Aprovação de plano** com opção de execução automática (⚡).
- **Backups versionados** antes de cada alteração (até 10 versões por arquivo) — restaure pelo botão ↩️.
- **Executar comandos** no projeto (ex.: `npm test`, `npm run build`) — barra ▶️ ou `/run <comando>` no chat.
- **Busca** por nome de arquivo e conteúdo no explorador (🔍).
- **Histórico de chat por projeto** e **projetos recentes**.
- **Git**: status e commit pelo botão 🔀.
- **Publicação automática de membros**: detecta repositório GitHub/GitLab na pasta e publica tags/com aceite um clique (botão 🚀).
- **Modos de trabalho**: Equipe, Esclarecer, Código e Arquitetura (ajustam o comportamento da IA).
- **Contexto de conversa**: a IA leva em conta o histórico do chat.
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
