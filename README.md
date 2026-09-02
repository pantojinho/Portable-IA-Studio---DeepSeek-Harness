# AI Studio

Estúdio de IA local e **portátil** (Windows · macOS · Linux): texto, imagem, vídeo, fala, música, OCR,
projetos de documentos com memória e busca, agente de código embutido (DeepSeek Harness) e APIs
OpenAI-compatíveis. Nada é instalado no sistema: copiar a pasta é mover a instalação.

Baseado no que já funciona em [Uncensored-Local-Studio](https://github.com/techjarves/Uncensored-Local-Studio)
e [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## Estado (set/2026)

| Fase | Estado |
|---|---|
| 0 · Fundação portátil (launchers, Node portátil, servidor único, jobs com histórico, SSE, doctor) | **pronto** |
| 1 · Gerenciador de modelos (cole um link → plano → download validado → biblioteca) | **pronto** |
| 2 · Motores: llama.cpp e stable-diffusion.cpp servindo `/v1` + provedores remotos por `provedor:modelo` | **pronto** |
| 3 · Áudio: transcrição com falantes, vozes (Piper/Kokoro/OuteTTS/clonagem), reuniões gravadas e resumidas, música | **pronto** |
| 4 · Documentos: projetos, ingestão (PDF/Word/Excel/PowerPoint/e-mail/áudio), OCR, busca híbrida, perguntas com citações, notas fiscais validadas e cruzadas com planilha | **pronto** |
| 5 · Interface: todas as telas na UI sem build (React fica como refinamento) | **pronto** |
| 6 · Agente com MCP, vídeo, serviço nos 3 SO, empacotamento de release | **pronto** |
| Rodar com GPU e pesos reais (promover receitas, `sd-server`, hashes do catálogo) | pendente na máquina do dono — [`docs/SPRINTS.md`](docs/SPRINTS.md) |

O bug de download do projeto original (página HTML salva como modelo) está resolvido na raiz:
nada entra na biblioteca sem passar pela inspeção de bytes e pela verificação de hash.

## Usar

| Sistema | Abrir |
|---|---|
| Windows | duplo clique em `start.bat` |
| macOS | duplo clique em `start.command` (ou `./aistudio serve`) |
| Linux | `./start.sh` |

Na primeira execução o launcher baixa um Node.js 24 portátil para `runtime/` (≈ 30–45 MB).
A interface abre em `http://127.0.0.1:1420` com Chat, Imagens, Vídeo, Projetos, Áudio, Reuniões,
Modelos, Motores & APIs, Agente, Configurações e Trabalhos. Guia de uso: [`docs/USO.md`](docs/USO.md).

```
aistudio serve [--host 0.0.0.0] [--port N] [--no-open] [--api-key K] [--data-dir D]
aistudio doctor
aistudio models list | resolve <link> | pull <link> | inspect <arquivo> | recipes | migrate [--import] | token hf <TOKEN>
aistudio engines list | adopt | install <motor> | start <modelo>
aistudio providers list | key <id> <CHAVE>
aistudio run "pergunta" [--model id]
aistudio agent install | start | run "tarefa"
aistudio projects new "Notas 2026" | add <projeto> <arquivos> | ingest | ask "pergunta" | extract | crosscheck
aistudio speak "bom dia" --voice <id> --out ola.wav
aistudio transcribe reuniao.mp4 --diarize --format srt --out reuniao.srt
aistudio meeting devices | start --title "Diária" | stop
aistudio config show | set <chave> <valor> | keys new
aistudio service install | status | logs
```

Primeira vez numa máquina que já tinha o Uncensored-Local-Studio ao lado: `aistudio engines adopt` e
`aistudio models migrate --import` reaproveitam binários e modelos por hardlink (nada é copiado nem apagado).

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

```bash
npm run test:api     # sobe o servidor e checa os contratos (OpenAI, projetos, MCP)
npm run release      # pacotes portáteis por sistema em dist/release/
AISTUDIO_LIVE=1 npx vitest run server/src/models/civitai.live.test.ts   # teste que usa a internet
```

Documentação: [`docs/USO.md`](docs/USO.md) (guia do usuário) · [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/API.md`](docs/API.md) · [`docs/SPRINTS.md`](docs/SPRINTS.md) · [`docs/DECISIONS.md`](docs/DECISIONS.md) ·
plano completo em [`PLANO.md`](PLANO.md).

## Layout

```
aistudio/
├── aistudio(.cmd)  start.*     launchers
├── server/src/                 servidor (TypeScript → dist/server.cjs)
├── web/dist/index.html         interface (arquivo único, sem build)
├── models/recipes/             receitas de modelos (YAML)
├── engines/catalog.yaml        catálogo de builds dos motores por SO/GPU
├── documents/doctypes/         tipos de documento (NF-e, boleto, contrato…) em YAML
├── engines/python/             servidores Python do runner (clonagem de voz, música)
├── packaging/                  gerador dos pacotes por sistema
├── docs/                       arquitetura, API, uso, sprints, decisões
├── runtime/ engines/ models/   baixados sob demanda (fora do git)
├── projects/ voices/ data/     estado do usuário (fora do git)
└── agent/                      DSH_HOME do agente
```

Licença MIT.
