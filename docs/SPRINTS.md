# Sprints e tarefas

Backlog executável para trabalho em enxame. Cada tarefa é independente dentro do que suas
dependências permitem. Formato: **ID · título · tamanho (S ≤ 2 h, M ≤ 1 dia, L ≤ 3 dias) · deps**.
Status: `todo` · `doing(@quem, data)` · `review` · `done(data)`. Atualize este arquivo ao pegar/terminar.

Regras: `AGENTS.md`. Contratos: `server/src/*/types.ts`. API alvo: `docs/API.md`.
Reuso: ULS = `../Uncensored-Local-Studio-main`, referências de linha em `scripts/server/serve.cjs` (7.275 linhas).

Prioridade do dono: **S3 (Áudio) e S4 (Documentos)** logo após o mínimo da S2.

**Estado em 2026-09-02:** S3 e S4 escritas por inteiro, mais MCP (AGT-04), vídeo (VID-01), serviço
(SVC-01), empacotamento (REL-01), guia de uso (REL-02), suíte de compatibilidade (API-02) e as telas
correspondentes. O que sobra depende da máquina do dono (GPU, downloads reais) ou é hardening:
MOD-09, ENG-01b, ENG-05b (`sd-server`), a migração da UI para React (S5) e a S7 inteira.

---

## S1 · Fundação + Modelos — `done(2026-09-02)` exceto onde marcado

| ID | Tarefa | Tam | Status |
|---|---|---|---|
| CORE-00 | Esqueleto TS+esbuild, launchers 3 SO, Node portátil, config, log, portas, bus, jobs, doctor | M | done |
| MOD-01 | Inspeção por bytes (GGUF/safetensors/ggml/onnx/html) | M | done |
| MOD-02 | Parser de referências (HF/CivitAI/hf://, org/repo:quant, recipe:) | S | done |
| MOD-03 | Cliente HF (info, tree paginada, busca, derivados quantizados, HEAD) | S | done |
| MOD-04 | Resolvedor → plano (receitas, GGUF, checkpoint único, ONNX, derivados, Python) | L | done |
| MOD-05 | Downloader (.part, resume, sniff anti-HTML, sha256, rename atômico) | M | done |
| MOD-06 | Registro/biblioteca + sidecars + importação + varredura de migração | M | done |
| MOD-07 | Download em chunks paralelos atrás da mesma assinatura de `downloadFile` | S | done(2026-09-02) — só entra com arquivo > 64 MiB, servidor com Range e `downloads.parallelChunks > 1`; retoma pelo `.part.json`. Falta medir o ganho no link do dono para escolher o padrão |
| MOD-08 | Extrair `.zip`/`.tar.bz2` baixados (voices packs) e registrar conteúdo | S | done(2026-09-02) — receitas aceitam `from.url` + `extract: true`; o pacote vira pasta com `aistudio.pack.json` |
| MOD-09 | Promover receitas: rodar cada uma de ponta a ponta e marcar `verified` | M | todo · precisa da máquina do dono (GPU + downloads reais); todas as novas nasceram `draft` |
| MOD-10 | Teste ao vivo do CivitAI + receita de LoRA de exemplo | S | done(2026-09-02) — `civitai.live.test.ts` roda com `AISTUDIO_LIVE=1`; receita `lora-exemplo-civitai` mostra o formato |
| CORE-01 | Persistir jobs em `data/jobs.sqlite` (`node:sqlite`) para sobreviver a reinício; histórico na UI | S | done(2026-09-02) |
| CORE-02 | `PUT /api/v1/config` com validação e hot-reload das chaves seguras (idle, downloads) | S | done(2026-09-02) |

Aceite S1 (já cumprido): os 10 links de aceitação resolvem para planos corretos
(`node dist/server.cjs models resolve <link>`); `models migrate` marca os HTML falsos; 24 testes verdes.

---

## S2 · Motores: texto + imagem + `/v1` — `done(2026-09-02)` na versão mínima

Feito e testado na A1000: ENG-01 (catálogo + adoção do ULS por hardlink; download do catálogo escrito, não testado),
ENG-02 (supervisor: spawn, health, idle, orçamento VRAM LRU), ENG-04 (llama.cpp: chat/embeddings/rerank/mmproj),
ENG-05 em modo cli (sd-cli; sd-server fica como ENG-05b), ENG-06/07/08 (`/v1/chat/completions` stream, `/v1/completions`,
`/v1/embeddings`, `/v1/rerank`, `/v1/images/generations`), ENG-09 (rotas/CLI de motores), ENG-10 (galeria mínima),
ENG-11 (adoção). Provedores remotos por `provedor:modelo` (openai, anthropic, deepseek, openrouter, groq, ollama).
Pendências desta sprint viram tarefas abaixo (mantidas para detalhamento/hardening).

| ID | Tarefa | Tam | Deps |
|---|---|---|---|
| ENG-05b | `/v1/images/edits`, upscale (ESRGAN) e LoRA por `--lora-model-dir` + `<lora:nome:peso>`: done(2026-09-02). `sd-server` persistente: **todo** (o modo CLI recarrega o checkpoint a cada imagem) | M | — |
| ENG-03b | Planejador conta a VRAM do sd.cpp (pesos + latentes por resolução) | S | done(2026-09-02) — falta conferir com `nvidia-smi` na A1000 |
| ENG-01b | Testar `install` do catálogo em máquina limpa nos 3 SO e preencher hashes | M | todo · versões de whisper.cpp, sherpa-onnx e sqlite-vec fixadas mas **não baixadas** deste ambiente |
| ENG-12 | Configurações por modelo em `data/model-settings.json` + rotas `/engines/model-settings` | S | done(2026-09-02) |
| ENG-01 | **Catálogo e instalador de motores.** `engines/catalog.yaml` (llama.cpp, sd.cpp, whisper.cpp, ffmpeg, onnxruntime por SO×GPU) + `engines/installer.ts`: baixa release oficial do GitHub, confere hash, extrai só `keep`, grava `engines/<id>/<os-arch>/<backend>/install.json`. Reuso: ULS `scripts/config/llm-backends.json`, `scripts/setup/setup-llama.ps1/.sh`, `setup-whisper.*`, `serve.cjs` L4886–4902 (URLs sd.cpp) e L4960–5110 (download+unzip de backend). Aceite: `aistudio engines install llamacpp` numa máquina limpa deixa `llama-server` executável; `doctor` lista. | M | — |
| ENG-02 | **Supervisor de processos.** `engines/supervisor.ts`: spawn com `windowsHide`, captura de stdout/err em `data/logs/<engine>.log`, health polling, porta livre (`core/ports.ts`), descarga por inatividade (`config.engines.idleUnloadMinutes`), `engine.status` no bus, `stopAll` no SIGINT. Reuso: ULS `serve.cjs` L1857–1868 (porta), L2741 (health `/v1/models`), L4378 (spawn llama-server). Aceite: teste com processo fake (script node que abre porta) cobrindo start/health/idle/stop. | M | — |
| ENG-03 | **Planejador de VRAM.** `engines/planner.ts`: estima VRAM por instância (GGUF: tamanho×1.1 + KV(ctx); sd.cpp: tamanho dos arquivos + margem por resolução), soma instâncias vivas, decide descarga LRU. Entrada `config.engines.vramBudgetMiB`. Aceite: testes de tabela (6 GB: Qwen3-4B Q4 + SD1.5 cabem; + Flux.2 não). | S | ENG-02 |
| ENG-04 | **Adaptador llama.cpp.** `engines/llamacpp.ts`: args a partir de settings (threads, ctx, ngl, cache-type-k/v, flash-attn, jinja, mmproj, embedding/rerank/pooling), `launch` espera `/health`, `run` para chat (stream), completion, embeddings, rerank, visão/OCR (imagem em base64 no conteúdo). Reuso: ULS `serve.cjs` L4370–4470 (args e settings por modelo em `app/config/llm-model-settings.json`), L6478–6600 (chat completions). Aceite: `curl /v1/chat/completions` com Qwen3-4B; `curl /v1/embeddings` com Qwen3-Embedding; OCR de uma imagem com GLM-OCR devolve Markdown. | L | ENG-01, ENG-02 |
| ENG-05 | **Adaptador stable-diffusion.cpp.** `engines/sdcpp.ts`: modo `sd-server` (proxy `/sdapi` e `/v1/images`) quando disponível, senão `sd-cli` por job; monta args pela receita (`engineArgs.sdcpp` com `{slots}`) ou pelo checkpoint único; txt2img/img2img/inpaint/upscale; grava PNG + JSON de parâmetros em `data/outputs`. Reuso: ULS `serve.cjs` L3860–4200 (seleção de backend/dispositivo Vulkan, `SD_VULKAN_DEVICE`), L5889 (proxy), `Generator.jsx` (parâmetros). Aceite: SDXL base e Flux.2 klein geram imagem na A1000 6 GB (klein com `--offload-to-cpu`). | L | ENG-01, ENG-02, ENG-03 |
| ENG-06 | `/v1/chat/completions`, `/v1/completions`, `/v1/models` (lista biblioteca + instâncias), auto-start do motor pelo campo `model`, stream SSE fiel ao OpenAI (`data: [DONE]`). Aceite: SDK `openai` (node) conversa com o Studio; Open WebUI conecta. | M | ENG-04 |
| ENG-07 | `/v1/images/generations` e `/v1/images/edits` (b64_json/url) mapeando para ENG-05. | S | ENG-05 |
| ENG-08 | `/v1/embeddings` (batch, `encoding_format`), `/api/v1/rerank`. | S | ENG-04 |
| ENG-09 | Rotas `/api/v1/engines/*` + CLI `aistudio engines list|install|start|stop`. | S | ENG-01, ENG-02 |
| ENG-10 | Galeria: `data/outputs` com metadados, `GET /api/v1/outputs`, apagar, favoritar. Reuso: ULS `outputs/*.json`. | S | ENG-05 |
| ENG-11 | Migrar binários já baixados pelo ULS (`app/llm-backend/win/cuda`, `app/backend/win/*`, `app/speech-backend`) para `engines/` via hardlink, se a versão bater com o catálogo — evita re-download de 3 GB. | S | ENG-01 |

Aceite S2: `curl /v1/chat/completions` e `/v1/images/generations` funcionam; Open WebUI conecta; 6 GB de VRAM respeitados.

---

## S3 · Áudio (prioridade)

| ID | Tarefa | Tam | Deps |
|---|---|---|---|
| AUD-10 | `done(2026-09-02)` **Runner Python (uv).** `engines/python-venv.ts`: cria venv em `engines/python-venv/<pacote>/` com `uv` portátil (baixar binário do uv para `engines/uv/`), instala requisitos fixados, sobe um pequeno servidor HTTP (`python/<pacote>/server.py`) que fala o contrato `EngineAdapter.run`. Sem Python no sistema: `uv python install 3.12` dentro da pasta. Aceite: `aistudio engines install python:demo` roda um "eco". | M | ENG-01, ENG-02 |
| AUD-01a | `done(2026-09-02)`: whisper-cli por job, `POST /v1/audio/transcriptions` (json/text/srt/verbose_json), só WAV 16 kHz até AUD-07. | — | — |
| AUD-01 | `done(2026-09-02)` **STT whisper.cpp (completo).** `engines/whispercpp.ts` (whisper-cli/whisper-server), VAD, timestamps por palavra, diarização com `tinydiarize` (modelo `-tdrz`) e/ou segmentação de falantes por sherpa-onnx, tradução. `/v1/audio/transcriptions` (multipart, `response_format` json/verbose_json/srt/vtt/text). Reuso: ULS `serve.cjs` L6149 (download), `SpeechTranscriber.jsx`, `scripts/setup/setup-whisper.*`. Aceite: transcrever 5 min de áudio PT-BR com falantes. | M | ENG-01, ENG-02 |
| AUD-02 | `done(2026-09-02)` **Registro de vozes + `/v1/audio/speech`.** `audio/voices.ts` (voices/<id>/voice.json), `GET/POST/DELETE /api/v1/voices`, preview, voz padrão por idioma, `/v1/audio/speech` roteando pelo `Voice.engine`; formatos wav/mp3 (ffmpeg). | M | AUD-03 ou AUD-04 |
| AUD-03 | `done(2026-09-02)` **Piper por sherpa-onnx.** Executar vozes VITS do Piper: opção A `sherpa-onnx` (binários prebuilt em `engines/sherpa-onnx/`, CLI `sherpa-onnx-offline-tts`); opção B `piper` binário oficial. Escolher A (também cobre Kokoro, VAD, diarização). Voz pt-BR padrão: receita `piper-pt-br-faber`. Aceite: falar 2 frases em < 1 s na CPU. | M | ENG-01 |
| AUD-04 | `done(2026-09-02)` **Kokoro por sherpa-onnx.** Pelo sherpa-onnx (kokoro-v1.0 int8 + voices.bin) ou portar `../Uncensored-Local-Studio-main/scripts/workers/tts-kokoro-worker.mjs` (kokoro-js) como *engine runtime* baixado sob demanda (não no bundle). Vozes PT-BR: pf_dora, pm_alex, pm_santa. | M | ENG-01 |
| AUD-05 | `done(2026-09-02)` **OuteTTS via llama-tts** (clonagem leve com amostra curta). `llama-tts` + WavTokenizer; receita `outetts-1.0-1b`. | M | ENG-04 |
| AUD-06 | `done(2026-09-02)` **Clonagem premium (venv):** Chatterbox, XTTS-v2, F5-TTS (incl. `firstpixel/F5-TTS-pt-br`). Um servidor Python por motor, mesma API interna `POST /tts {text, ref_wav}`. Marcar licenças não comerciais na receita. | L | AUD-10 |
| AUD-07 | `done(2026-09-02)` **ffmpeg portátil + captura.** Catálogo por SO (builds estáticos), `audio/capture.ts`: dispositivos (`-list_devices`), gravar mic e áudio do sistema (Windows `dshow`/WASAPI loopback via `virtual-audio-capturer` ou `-f wasapi`; macOS `avfoundation` + BlackHole/ScreenCaptureKit; Linux `pulse` monitor), mux para wav 16 kHz mono. Fallback: navegador `getDisplayMedia({audio:true})` enviando chunks por WebSocket. | M | ENG-01 |
| AUD-08 | `done(2026-09-02)` **Reuniões.** `audio/meetings.ts`: iniciar/parar (job), transcrição incremental (janelas de 20 s no whisper), diarização, evento `meeting.transcript`, ao final resumo/decisões/ações/perguntas pelo LLM local (prompt em PT-BR, JSON), export md/docx/srt, ingestão automática no projeto (DOC-02). Rotas em `docs/API.md`. | L | AUD-01, AUD-07, ENG-04 |
| AUD-09 | `done(2026-09-02)` **Música (venv):** ACE-Step (letra+estilo), MusicGen small, Stable Audio Open small (efeitos). `POST /api/v1/audio/music` (job). Testar em 6 GB com offload. | L | AUD-10 |

Aceite S3: reunião gravada, transcrita com falantes e resumida; 3 motores de voz na mesma API; `/v1/audio/speech` e `/v1/audio/transcriptions` compatíveis.

---

## S4 · Projetos e documentos (prioridade)

| ID | Tarefa | Tam | Deps |
|---|---|---|---|
| DOC-00 | `done(2026-09-02)` **SQLite + extensões.** `core/db.ts` com `node:sqlite` (`allowExtension`), catálogo de `sqlite-vec` prebuilt por SO em `engines/sqlite-ext/`, migrations simples, FTS5 (já embutido). Aceite: teste inserindo vetores e consultando `vec_distance_cosine`. | S | ENG-01 |
| DOC-01 | `done(2026-09-02)` **Projetos.** `documents/projects.ts`: criar/listar/renomear/apagar (mover para lixeira `data/trash`, nunca `rm` direto), esquema `index.sqlite` (sources, chunks, chunks_vec, chunks_fts, memory, fields), `memory.md` espelhado. Rotas `/api/v1/projects*`. | M | DOC-00 |
| DOC-02 | `done(2026-09-02)` **Ingestão.** `documents/ingest.ts` (job `ingest`): detectar tipo (magic + extensão), extratores: PDF texto (`pdfjs-dist` legacy build, puro JS), DOCX (`mammoth`), XLSX/CSV (`xlsx` ou `exceljs`), PPTX (`jszip` + XML), EML/MSG (`mailparser`), TXT/MD/HTML (`turndown`), áudio/vídeo → AUD-01. PDF sem camada de texto → DOC-03. Saída: Markdown em `derived/`. Pasta monitorada com `fs.watch` debounced. | L | DOC-01 |
| DOC-03 | `done(2026-09-02)` **OCR pelo llama.cpp.** `documents/ocr.ts`: renderizar página (pdfjs → PNG via `canvas`? não — usar `pdftoppm`/`mutool` portátil no catálogo ou o rasterizador do pdf.js com `@napi-rs/canvas` como *engine runtime*; decidir e registrar), tiles para páginas grandes, prompt do GLM-OCR para Markdown e para JSON-schema, `POST /api/v1/ocr` (lote, job), export md/json/csv/xlsx. RapidOCR (onnx, sherpa/rapidocr) como motor rápido alternativo. Aceite: 20 páginas escaneadas em PT-BR → Markdown legível com tabelas. | L | ENG-04, DOC-00 |
| DOC-04 | `done(2026-09-02)` **Chunking + embeddings + busca híbrida.** Chunking por estrutura (títulos, tabelas inteiras, parágrafos; `chunkTokens`/`overlap`), embeddings via `/v1/embeddings` (Qwen3-Embedding-0.6B ou bge-m3), gravação em `chunks_vec` + `chunks_fts`, busca híbrida (RRF) + reranker (bge-reranker) opcional. `POST /projects/:id/search`. | M | DOC-01, ENG-08 |
| DOC-05 | `done(2026-09-02)` **Perguntar com citações.** `POST /projects/:id/ask` (stream): prompt PT-BR com trechos numerados, resposta cita `[n]`, mapeia para `{sourceId, page, quote}`; guarda a conversa em `chats/`. | M | DOC-04, ENG-06 |
| DOC-06 | `done(2026-09-02)` **Memória.** Extração de fatos/glossário/resumo na ingestão (modelo pequeno, JSON), tabela `memory` + `memory.md`, injeção no system prompt dos chats do projeto, memória global em `data/memory.md`, "lembrar isto" pela API. | M | DOC-04 |
| DOC-07 | `done(2026-09-02)` **Tipos de documento, extração e validação.** `documents/doctypes/*.yaml` (nfe, nfse, recibo, boleto, contrato, fatura, extrato), classificador (hints + LLM pequeno), extração por JSON schema (GLM-OCR nativo ou llama.cpp `--grammar` a partir do schema), `documents/validators.ts` (chave NF-e 44 dígitos DV mod 11, CNPJ, CPF, soma itens = total, datas, duplicidade por chave/número), cruzamento com tabela importada (CSV/XLSX) com relatório de divergências. Aceite: lote de notas escaneadas → relatório. | L | DOC-03, DOC-04 |
| DOC-08 | `done(2026-09-02)` **Conectores.** Interface `Connector`; implementar `folder` (watch) e `imap` (`imapflow`, só leitura, anexos → ingestão). Esboçar `sap-odata` (somente contrato + mock). | M | DOC-02 |
| DOC-09 | `done(2026-09-02)` **Tela OCR (API).** Endpoints de lote com prévia por página (PNG + caixas quando o motor devolve layout), texto editável salvo em `derived/`, export. | S | DOC-03 |
| DOC-10 | `done(2026-09-02)` **Ferramentas MCP de projeto** (`search_project`, `read_document`, `ocr_file`, `extract_fields`, `validate_document`, `check_against_table`) no servidor MCP do Studio. | S | AGT-04, DOC-04, DOC-07 |

Aceite S4: 50 notas escaneadas classificadas, extraídas, validadas e cruzadas com um XLSX; "quais vencem este mês?" responde com citações.

---

## S5 · Interface

**Estado (2026-09-02):** todas as telas existem e funcionam na UI de arquivo único (`web/dist/index.html`,
sem build): Chat, Imagens, Vídeo, Projetos (documentos, perguntas com citações, notas fiscais, memória),
Áudio (falar, vozes, clonagem, transcrição, música), Reuniões (gravar, transcrição ao vivo, resumo),
Modelos, Motores & APIs, Agente, Configurações e Trabalhos. Testadas num Chromium de verdade (11 abas,
sem erro de JavaScript, fluxo de projeto ponta a ponta).

O que a migração para React (UI-01…UI-11) ainda traria: componentização e testes de interface, i18n
PT-BR/EN, PWA e as telas de "Treinar". As chamadas de API já estão prontas e não mudam.

Design: instalar `npx impeccable install` no repo e rodar `/impeccable init` antes de UI-01; tokens de cor/tipografia em `web/src/theme.ts`. Referência visual: telas enviadas pelo dono (barra lateral: Novo chat · Projetos · Hub de modelos · Imagens · Vídeo · Treinar · Mais; página Projetos com "Create project → nome + Sources").

| ID | Tarefa | Tam | Deps |
|---|---|---|---|
| UI-00b | `done(2026-09-02)` Telas de Projetos, Áudio, Reuniões, Vídeo e Configurações na UI sem build (as mesmas chamadas que a S5 vai reaproveitar) | M | — |
| UI-01 | Scaffold Vite+React+TS em `web/`, build para `web/dist`, cliente de API tipado (`web/src/api.ts`), hook de SSE, i18n PT-BR/EN, tema claro/escuro, PWA manifest. | M | — |
| UI-02 | Shell: barra lateral, recentes, monitor CPU/RAM/GPU/VRAM (reuso `TopStatusBar.jsx`), toasts de jobs. | M | UI-01 |
| UI-03 | Chat (reuso `TextChat.jsx`): modelos da biblioteca, stream, histórico, anexos de imagem, seleção de projeto (contexto). | M | UI-01, ENG-06 |
| UI-04 | Hub de modelos (reuso `ModelManager.jsx`): colar link → plano (arquivos, tamanhos, avisos, alternativas de quant) → baixar com progresso; receitas com status; busca HF; migração da instalação antiga com os arquivos ✘ marcados; tokens. | L | UI-01 |
| UI-05 | Imagens (reuso `Generator.jsx`): parâmetros, LoRA, galeria, img2img/inpaint/upscale. | M | ENG-05 |
| UI-06 | Vídeo: t2v/i2v, prévia de frames, fila. | M | VID-01 |
| UI-07 | Áudio: Vozes (lista, preview, clonar com amostra), Falar (reuso `TextToSpeech.jsx`), Música. | M | AUD-02 |
| UI-08 | Reuniões: gravar (fontes), transcrição ao vivo, resumo, export, enviar ao projeto. | M | AUD-08 |
| UI-09 | Projetos + Documentos + OCR: lista/criar (modal nome + fontes), fontes com status de ingestão, perguntar com citações e trecho ao lado, memória editável, tela OCR (arrastar, prévia, texto editável, export), tipos de documento e relatório de validação. | L | DOC-05, DOC-07, DOC-09 |
| UI-10 | Agente: aba com o dsh embutido (iframe + estado), seletor de workspace, instalar/iniciar. | S | AGT-03 |
| UI-11 | APIs: endereços, chave, exemplos curl/python/js prontos, toggle LAN. Configurações: motores, portas, idle, serviço, idioma, tema. | S | CORE-02 |

---

## S6 · Agente, APIs, serviço, release

| ID | Tarefa | Tam | Deps |
|---|---|---|---|
| AGT-01 | `done(2026-09-02)`: `aistudio agent install` usa **pnpm** (`npx pnpm@11 add`) — o npm levou >25 min sem terminar na árvore do dsh; pnpm resolve em ~1 min. Nativos (node-pty, koffi) via `onlyBuiltDependencies`. Pendente: testar em máquina sem Node no sistema (usar o npm/npx do runtime portátil). | — | — |
| AGT-02 | `done(2026-09-02)` mínimo: `settings.yaml` com provedor `local` (baseURL do Studio, compat) e provedores com chave. Pendente: validar cada campo contra `config-catalog.md` do dsh; registrar o MCP do Studio (AGT-04). | S | — |
| AGT-03 | `done(2026-09-02)` mínimo: `dsh web` supervisionado (`POST /api/v1/agent/start` → ready em ~10 s na máquina do dono), aba Agente na UI com iframe. Pendente: confirmar no dsh que o provedor `local` aparece e responde; proxy same-origin se o iframe bloquear. | M | — |
| AGT-04 | `done(2026-09-02)` **Servidor MCP do Studio** em `/mcp` (streamable HTTP, `@modelcontextprotocol/sdk` — verificar que não traz módulos nativos): `chat`, `generate_image`, `generate_video`, `speak`, `transcribe`, `ocr_file`, `list_models`, `download_model`. Ferramentas de projeto em DOC-10. | M | ENG-06, ENG-07 |
| AGT-05 | `review`: `aistudio agent run "tarefa"` e `POST /api/v1/agent/run` escritos (headless); testar após AGT-01. SDK Python: documentar. | S | AGT-01 |
| UI-00 | `done(2026-09-02)`: UI mínima sem build em `web/dist/index.html` (Chat com stream, Imagens + galeria, Modelos com plano/download/migração/tokens, Motores & APIs com provedores, Trabalhos por SSE). A S5 substitui por React mantendo as mesmas chamadas. | — | — |
| VID-01 | `done(2026-09-02)` Vídeo pelo sd.cpp `vid_gen` (Wan 2.2 5B, LTX-2): flags conforme `docs/wan.md` do sd.cpp, frames → mp4 via ffmpeg, `POST /api/v1/generate/video`. | M | ENG-05, AUD-07 |
| API-01 | `done(2026-09-02)` API keys (`--api-key`, várias chaves em `data/secrets/api_keys`), CORS, `--host` recusado sem chave, rate-limit por minuto. | S | — |
| API-02 | `done(2026-09-02)` Suíte de compatibilidade OpenAI com o SDK oficial (chat stream, images, audio, embeddings) rodando contra o Studio no CI (modelos pequenos). | M | ENG-06/07/08, AUD-01/02 |
| SVC-01 | `done(2026-09-02)` `aistudio service install|uninstall|status|start|stop|logs`: Windows (schtasks ao logon; `sc` com admin), macOS (LaunchAgent), Linux (systemd --user). Reinício automático, `--headless`. | M | — |
| REL-01 | `done(2026-09-02)` Empacotamento: `packaging/build-release.mjs` (zip por SO com Node portátil + dist + web/dist + receitas), GitHub Actions matriz win/mac/linux (typecheck, testes, build, artefatos). | M | UI-01 |
| REL-02 | `done(2026-09-02)` Docs de usuário (`docs/USO.md`) (README por SO, FAQ de GPU/antivírus/portas) e página "Instalar como serviço". | S | SVC-01 |

---

## S7 · Futuro (esqueleto previsto)

| ID | Tarefa |
|---|---|
| PER-01 | Persona: voz clonada (AUD-06), estilo por RAG dos próprios e-mails (DOC-08 imap), rascunho → aprovação → envio (SMTP), nunca automático. |
| PER-02 | Avatar com lip-sync (MuseTalk/LatentSync) pela venv — pesado, opcional. |
| TRN-01 | Treinar: LoRA de imagem (kohya/sd-scripts) e de LLM (unsloth) pela venv, limitado por VRAM. |
| COL-01 | colibri como motor (`coli serve`) para MoE gigantes do SSD. |
| NPU-01 | OpenVINO NPU / CoreML (portar workers do ULS `scripts/workers/*.py`). |
| TAU-01 | Janela nativa + bandeja (Tauri) opcional. |

## Backlog / ideias
- Chunks paralelos no downloader só se medição mostrar ganho (MOD-07).
- Espelho HF configurável (`downloads.hfMirror`) já existe no config; testar com hf-mirror.com.
- Detectar GPU Intel Arc/AMD no Windows → Vulkan (já no `system.ts`), validar com máquina real.
