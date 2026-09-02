# Arquitetura do AI Studio

Leia `AGENTS.md` primeiro. Este documento diz **como as peças se encaixam** e quais contratos
existem entre elas. Contratos vivem em `server/src/<domínio>/types.ts` e só mudam com registro em
`docs/DECISIONS.md`.

## 1. Visão em uma tela

```
                 ┌───────────────────────── web/dist (React, PWA) ─────────────────────────┐
                 │ Chat · Projetos · Documentos&OCR · Hub de modelos · Imagens · Vídeo ·   │
                 │ Áudio(Vozes,Música) · Reuniões · Agente(dsh embutido) · APIs · Config   │
                 └──────────────┬──────────────────────────────┬───────────────────────────┘
                                │ /api/v1 (nativa, SSE)        │ /v1 (OpenAI)      /mcp (MCP)
┌───────────────────────────────▼──────────────────────────────▼─────────────────────────────┐
│ dist/server.cjs  (Hono)                                                                    │
│  core: paths · config · log · ports · events(bus) · jobs · system(GPU/RAM) · context       │
│  models: refs → resolver(HF/CivitAI/receitas) → downloader(valida bytes, sha) → registry   │
│  engines: registry+supervisor(VRAM planner) → adaptadores ──┐                              │
│  audio: vozes · tts · stt · reuniões · música               │                              │
│  documents: projetos · ingestão · ocr · índice · extração   │                              │
│  agent: supervisor do dsh · settings.yaml · ponte MCP       │                              │
└─────────────────────────────────────────────────────────────┼──────────────────────────────┘
                                                              ▼ processos-filho (engines/)
   llama-server (texto, visão, OCR, embeddings, rerank, OuteTTS)   sd-cli/sd-server (imagem, vídeo)
   whisper-cli (STT)   onnxruntime (Piper, Kokoro, RapidOCR)   ffmpeg (captura/transcode)
   python-venv via uv (clonagem de voz, música, diffusers)   dsh web (agente)   colibri (opcional)
```

Tudo dentro da pasta raiz. `runtime/` (Node portátil), `engines/`, `models/`, `projects/`, `voices/`,
`data/`, `agent/` são estado; o resto é código.

## 2. Ciclo de vida de uma requisição longa

1. Rota recebe a chamada e valida entrada (400 se ruim).
2. Cria um **job** (`ctx.jobs.create(kind, título, fn)`) e devolve `{ job }` na hora.
3. O job publica progresso no **bus** (`bus.publish("job", info)`); a UI/CLI seguem por `GET /api/v1/events`.
4. Saídas vão para `data/outputs/` (imagens, áudio, vídeo) ou para a pasta do projeto; o resultado do job
   referencia caminhos, nunca embute binários.
5. Cancelamento: `POST /api/v1/jobs/:id/cancel` → `AbortSignal` chega ao motor.

Concorrência por tipo de job: `download` = `config.downloads.parallelFiles`, `generate`/`ocr`/`ingest` = 1
(o planejador de VRAM decide o que coexiste; ver ENG-03).

## 3. Modelos (pronto)

- `refs.ts`: qualquer forma de link → `ParsedRef`.
- `resolver.ts`: `ParsedRef` → `DownloadPlan` (arquivos concretos com tamanho e sha). Ordem: arquivo
  explícito → receita que conhece o repo → repo GGUF → checkpoint único (SDXL…) → pacote ONNX →
  derivado GGUF (`filter=base_model:quantized:<repo>`) → "só roda por Python".
- `recipes.ts` + `models/recipes/*.yaml`: modelos multi-arquivo e como o motor os invoca (`engineArgs`
  com placeholders `{slot}`). **Adicionar modelo = adicionar YAML.**
- `downloader.ts`: `.part`, resume por Range, sniff dos primeiros 4 KB (rejeita HTML), sha256, rename atômico.
- `registry.ts`: biblioteca `models/<kind>/**`, inspeção cacheada por tamanho+mtime, sidecar
  `<arquivo>.aistudio.json` (origem, sha, receita, companheiros), importação (hardlink/cópia), varredura de
  migração (marca HTML falsos e downloads incompletos).
- `service.ts`: fachada usada pela API e pela CLI; `pull(plan)` vira job.

Orçamento de VRAM na escolha do quant: texto/OCR = 85 % da VRAM (ou metade da RAM sem GPU);
imagem/vídeo = 90 % da VRAM. Não coube → menor arquivo + aviso "vai usar offload".

## 4. Motores (contrato pronto, implementação nas sprints S2/S3)

`engines/types.ts#EngineAdapter`: `installed · install · launch · run · health · stop · estimateVramMiB`.
`engines/registry.ts` guarda adaptadores e instâncias; o **supervisor** (ENG-02) decide arranque, descarga
por inatividade e substituição quando a VRAM não comporta. Cada instância publica `engine.status`.

Catálogo de builds por SO/GPU em `engines/catalog.yaml` (ENG-01) — portado de
`../Uncensored-Local-Studio-main/scripts/config/llm-backends.json` e das URLs de release em
`scripts/server/serve.cjs` (linhas ~4886–4902 para sd.cpp). Instalação mantém só os executáveis usados
(`keep`), confere hash, nunca instala no sistema.

Modo servidor (llama-server, sd-server): o Studio faz proxy em `/v1` e agrega. Modo CLI (sd-cli, whisper-cli):
um processo por job. Python (uv venv em `engines/python-venv/`): um pequeno servidor HTTP por pacote,
falando o mesmo contrato.

## 5. Áudio (S3)

Registro de **vozes** (`audio/types.ts#Voice`) desacopla UI/API do motor. `/v1/audio/speech` recebe
`voice=<id>`. Motores sem Python primeiro (Piper, Kokoro via onnxruntime; OuteTTS via llama.cpp), clonagem
premium pela venv. STT por whisper.cpp com diarização. **Reuniões**: ffmpeg captura mic + sistema
(WASAPI loopback / ScreenCaptureKit·BlackHole / PulseAudio monitor), transcrição ao vivo, resumo pelo LLM
local, exportação e ingestão automática no projeto.

## 6. Projetos e documentos (S4)

Um projeto = uma pasta portátil. `index.sqlite` via **`node:sqlite`** com extensões `sqlite-vec`
(vetores) e `FTS5` (texto) carregadas de `engines/sqlite-ext/<os-arch>/`. Pipeline:
detectar tipo → extrair (pdf.js / mammoth / xlsx / pptx / eml / whisper) → OCR quando escaneado
(GLM-OCR pelo llama-server com `--mmproj`) → Markdown → chunking estrutural → embeddings (GGUF via
llama-server `--embedding`) → índice → busca híbrida + reranker → resposta com citações.
**Memória** (`memory.md` + tabela `memory`) entra no system prompt dos chats do projeto.
**Tipos de documento** são YAML (`documents/doctypes/`): JSON schema + validadores em código
(chave NF-e mod 11, CNPJ/CPF, soma de itens, datas) + cruzamento com tabela importada.

## 7. Agente (S6)

`agent/` é o `DSH_HOME`. O Studio instala `@deepseek-ai/dsh` **fixado** com o Node portátil
(`runtime/node/*/npm`), gera `settings.yaml` (provedor `local` → `http://127.0.0.1:<porta>/v1`,
`compat.maxTokensField: max_tokens`, `compat.supportsDeveloperRole: false`) e sobe `dsh web --no-open`.
O Studio expõe **/mcp** (streamable HTTP) com `chat`, `generate_image`, `generate_video`, `speak`,
`transcribe`, `ocr_file`, `search_project`, `read_document`, `extract_fields`, `validate_document`,
`list_models`, `download_model`; o dsh o consome como servidor MCP. Plugins do dsh e outros servidores
MCP funcionam nele sem adaptação.

## 8. Superfícies de API

- `/api/v1/*` nativa (JSON + SSE). Catálogo em `docs/API.md`.
- `/v1/*` OpenAI-compatível: `models`, `chat/completions`, `completions`, `embeddings`,
  `images/generations`, `images/edits`, `audio/speech`, `audio/transcriptions`, `audio/translations`.
- `/mcp` servidor MCP.
- Autenticação: sem chave em `127.0.0.1`; com `--host` público a chave é obrigatória (`Authorization: Bearer`).

## 9. Decisões já tomadas

Ver `docs/DECISIONS.md`. Resumo: Node 24 portátil; um arquivo de servidor; sem módulos nativos npm;
`node:sqlite` + extensões carregadas de `engines/`; receitas YAML; dsh embutido e fixado; 127.0.0.1 por padrão;
motores sob demanda por GPU; nunca apagar dados do usuário.
