# AGENTS.md — regras para quem trabalha neste repositório

Este arquivo é lido por agentes de IA e por pessoas. Ele existe para que várias frentes trabalhem
em paralelo sem se atropelar. Leia inteiro antes de tocar em qualquer coisa. Se algo aqui conflitar
com o que você acha melhor, siga o arquivo e registre a discordância em `docs/DECISIONS.md`.

## 1. O que estamos construindo

**AI Studio**: estúdio de IA local e portátil (Windows, macOS, Linux). Texto, imagem, vídeo, fala,
música, OCR, projetos de documentos com memória e busca (RAG), agente de código embutido
(DeepSeek Harness, `dsh`) e APIs OpenAI-compatíveis. Plano completo em `../PLANO.md`;
arquitetura em `docs/ARCHITECTURE.md`; backlog em `docs/SPRINTS.md`.

Projetos de referência (copiar o que já funciona, citando a origem no comentário):
- `../Uncensored-Local-Studio-main` (ULS): lançamento dos motores (`scripts/server/serve.cjs`),
  detecção de GPU, workers de whisper e kokoro, componentes React. Funciona redondo na máquina do dono.
- DeepSeek Harness (`@deepseek-ai/dsh` no npm, clone em scratchpad): embutir, não reescrever.
  Plugins e servidores MCP existentes devem funcionar nele sem adaptação.

## 2. Invariantes (não negociáveis)

1. **Portátil.** Nada é instalado no sistema. Tudo é relativo à pasta raiz (`core/paths.ts`).
   Copiar a pasta = mover a instalação. Funciona de pendrive/exFAT (sem symlinks obrigatórios).
2. **Leve.** O núcleo (`dist/server.cjs` + `web/dist` + Node portátil) fica abaixo de 100 MB.
   Motores, modelos, runtimes Python e o dsh são baixados **sob demanda**, só a variante da GPU do usuário.
3. **Um arquivo de servidor.** `server/src/**` vira `dist/server.cjs` via esbuild. **Sem módulos
   nativos do Node** no bundle. SQLite é `node:sqlite` (embutido no Node 24). Binários (llama.cpp,
   sd.cpp, whisper.cpp, ffmpeg, onnxruntime) são *motores* em `engines/`, nunca dependências npm.
4. **Nunca confie no nome do arquivo.** Todo peso é classificado pelos bytes (`models/inspect.ts`).
   Nenhum download entra na biblioteca sem passar por `downloader.ts` (rejeita HTML, confere hash).
5. **O Studio nunca apaga dados do usuário sozinho.** Migração importa por hardlink/cópia. Só apaga
   o que está dentro de `models/` quando o usuário manda, e nunca fora da própria biblioteca.
6. **Rede fechada por padrão.** Escuta em `127.0.0.1`. `--host 0.0.0.0` exige `--api-key`.
   O dsh nunca é exposto sem chave. Nenhum e-mail ou ação externa sai sem aprovação explícita.
7. **Trabalho longo é um job.** Tudo que demora mais que ~1 s (download, OCR, geração, ingestão)
   roda em `core/jobs.ts` e reporta progresso por `core/events.ts` → SSE `/api/v1/events`.
8. **Mensagens para humanos em português do Brasil**, claras, dizendo o que fazer.
   Identificadores de código em inglês. Comentários em inglês ou português, curtos.
9. **Receitas são dados.** Suporte a um modelo novo = entrada YAML em `models/recipes/`, não código.
   Toda receita declara `status` honesto: `verified` só depois de rodar de ponta a ponta no Studio.
10. **Segurança de execução.** Comandos gerados por modelo passam por sandbox/aprovação (dsh).
    Ferramentas MCP do Studio nunca executam shell arbitrário.

## 3. Layout e onde cada coisa mora

```
server/src/
  cli.ts            entrada: serve | doctor | models | (service, agent, projects…)
  core/             paths, config, log, ports, events (bus), jobs, system (GPU/RAM), context
  models/           inspect, refs, hf, resolver, recipes, downloader, registry, service
  engines/          contrato (types.ts) + registry + supervisor + um adaptador por motor
  audio/            vozes, TTS, STT, reuniões, música
  documents/        projetos, ingestão, OCR, índice (sqlite-vec+FTS5), extração, validadores, conectores
  agent/            supervisor do dsh, ponte MCP, settings.yaml
  api/              app.ts (Hono) + routes/<domínio>.ts ; /v1 (OpenAI) ; /api/v1 (nativa) ; /mcp
  commands/         subcomandos da CLI
web/                React + Vite (fase UI) → web/dist
models/recipes/     receitas YAML embutidas
docs/               ARCHITECTURE, SPRINTS, DECISIONS, API
```

Estado do usuário (fora do git): `runtime/ engines/ models/ projects/ voices/ data/ agent/`.

## 4. Convenções de código

- TypeScript estrito, ESM, `noUncheckedIndexedAccess`. Imports relativos com sufixo `.js`.
- Rotas: uma `Hono` por domínio em `api/routes/<x>.ts`, montada em `api/app.ts`. JSON sempre;
  erros `{ error: "mensagem em PT-BR" }` com status HTTP correto (400 entrada, 404, 422 semântico, 502 upstream).
- Logs: `logger("escopo")`. Nada de `console.log` fora da CLI.
- Config: `core/config.ts` (YAML em `data/config.yaml`). Segredos em `data/secrets/<nome>` (nunca no config).
- Eventos (tópicos do bus): `job`, `download.progress`, `download.done`, `engine.status`, `system.live`,
  `project.ingest`, `meeting.transcript`. Payload sempre JSON serializável.
- Testes: `vitest`, arquivo `*.test.ts` ao lado do módulo. Teste lógica pura e I/O com servidores locais
  (veja `downloader.test.ts`). Não chame a internet em testes unitários.
- Portas padrão: UI/API 1420 (cai para 1421–1499), llama-server 10086+, sd-server 8080+, dsh 3080.

## 5. Como adicionar

- **Motor**: implemente `engines/types.ts#EngineAdapter`, registre em `engines/registry.ts`, adicione a entrada
  de download em `engines/catalog.yaml` (por SO/GPU, com hash), escreva `engines/<id>.test.ts` com um mock de processo.
- **Endpoint**: rota em `api/routes/`, documente em `docs/API.md`, se for longo vire job.
- **Receita**: YAML em `models/recipes/`, valide com `aistudio models resolve recipe:<id>`, rode o modelo,
  então promova `status`.
- **Comando CLI**: `commands/<x>.ts` + `case` em `cli.ts` + linha no HELP.

## 6. Definição de pronto (para qualquer tarefa)

1. `npm run typecheck` e `npm test` verdes; `npm run build` gera `dist/server.cjs`.
2. Smoke manual pelo CLI ou `curl` descrito no PR/commit.
3. Docs tocadas: `docs/API.md` (endpoints), `docs/SPRINTS.md` (status da tarefa → `done`, com data).
4. Nenhum invariante da seção 2 violado. Nenhum módulo nativo novo. Nenhum download sem validação.
5. Commit: `<ÁREA>-<NN>: resumo curto` no corpo o que foi testado. Branch `task/<ID>`.

## 7. Protocolo de enxame

- Pegue uma tarefa em `docs/SPRINTS.md` com status `todo` cujas dependências estejam `done`.
  Marque `doing` com seu nome/agente e a data antes de começar.
- Mexa só nos arquivos listados na tarefa. Se precisar mudar um contrato (`*/types.ts`), pare,
  registre em `docs/DECISIONS.md` e avise no PR — outros dependem dele.
- Tarefas de motor (ENG/AUD/DOC) devem funcionar sem UI: prove pelo CLI ou `curl`.
- Não faça "melhorias" fora do escopo. Anote ideias em `docs/SPRINTS.md` seção Backlog.
- Quando reaproveitar código do ULS ou do dsh, cite arquivo e linhas no comentário.
- Antes de baixar algo grande em testes, use o plano (`models resolve`) — não gaste disco/rede à toa.

## 8. O que já está pronto (set/2026)

Fase 0 (fundação) e Fase 1 (gerenciador de modelos) — ver `docs/SPRINTS.md` S1. Os 10 links de
aceitação do dono resolvem para planos corretos; HTML nunca mais vira "modelo".
