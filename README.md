# AI Studio

Estúdio de IA local e **portátil** (Windows · macOS · Linux): texto, imagem, vídeo, fala, música, OCR,
projetos de documentos com memória e busca, agente de código embutido (DeepSeek Harness) e APIs
OpenAI-compatíveis. Nada é instalado no sistema: copiar a pasta é mover a instalação.

Baseado no que já funciona em [Uncensored-Local-Studio](https://github.com/techjarves/Uncensored-Local-Studio)
e [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## Estado (set/2026)

| Fase | Estado |
|---|---|
| 0 · Fundação portátil (launchers, Node portátil, servidor único, jobs, SSE, doctor) | **pronto** |
| 1 · Gerenciador de modelos (cole um link → plano → download validado → biblioteca) | **pronto** |
| 2 · Motores texto/imagem + `/v1` · 3 · Áudio · 4 · Documentos · 5 · UI · 6 · Agente/serviço | backlog em [`docs/SPRINTS.md`](docs/SPRINTS.md) |

O bug de download do projeto original (página HTML salva como modelo) está resolvido na raiz:
nada entra na biblioteca sem passar pela inspeção de bytes e pela verificação de hash.

## Usar

| Sistema | Abrir |
|---|---|
| Windows | duplo clique em `start.bat` |
| macOS | duplo clique em `start.command` (ou `./aistudio serve`) |
| Linux | `./start.sh` |

Na primeira execução o launcher baixa um Node.js 24 portátil para `runtime/` (≈ 30–45 MB).
A interface abre em `http://127.0.0.1:1420` (por enquanto uma página de status; a UI completa é a fase 5).

```
aistudio serve [--host 0.0.0.0] [--port N] [--no-open] [--api-key K] [--data-dir D]
aistudio doctor
aistudio models list | resolve <link> | pull <link> | inspect <arquivo> | recipes | migrate [--import] | token hf <TOKEN>
```

Exemplos que já funcionam:

```bash
aistudio models resolve https://huggingface.co/zai-org/GLM-OCR
aistudio models resolve https://huggingface.co/black-forest-labs/FLUX.1-dev
aistudio models pull https://huggingface.co/Tongyi-MAI/Z-Image-Turbo
aistudio models migrate            # encontra modelos da instalação antiga e marca arquivos falsos
```

## Desenvolver

Requer Node 24+. Leia [`AGENTS.md`](AGENTS.md) antes de contribuir.

```bash
npm install
npm run build        # gera dist/server.cjs (um único arquivo)
npm run dev          # build + serve sem abrir o navegador
npm test
npm run typecheck
```

Documentação: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/API.md`](docs/API.md) ·
[`docs/SPRINTS.md`](docs/SPRINTS.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md) · plano completo em [`PLANO.md`](PLANO.md).

## Layout

```
aistudio/
├── aistudio(.cmd)  start.*     launchers
├── server/src/                 servidor (TypeScript → dist/server.cjs)
├── web/                        interface (React + Vite → web/dist)
├── models/recipes/             receitas de modelos (YAML)
├── engines/catalog.yaml        catálogo de builds dos motores por SO/GPU
├── docs/                       arquitetura, API, sprints, decisões
├── runtime/ engines/ models/   baixados sob demanda (fora do git)
├── projects/ voices/ data/     estado do usuário (fora do git)
└── agent/                      DSH_HOME do agente
```

Licença MIT.
