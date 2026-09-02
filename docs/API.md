# API do AI Studio

Base: `http://127.0.0.1:1420`. Sem chave, o servidor só escuta em 127.0.0.1. Havendo qualquer chave
(`--api-key`, `data/secrets/api_keys` ou `aistudio config keys new`), toda chamada a `/api`, `/v1` e
`/mcp` exige `Authorization: Bearer <chave>` (ou `X-Api-Key`, ou `?api_key=`). Servir em `--host`
público sem chave é recusado na largada. `server.rateLimitPerMinute` (0 = sem limite) devolve 429 com
`Retry-After`. Erros: `{ "error": "mensagem" }` — no `/v1`, o envelope da OpenAI.
Status por endpoint: **pronto** · *planejado (ID da tarefa)*.

## Núcleo — pronto
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/v1/health` | versão e uptime |
| GET | `/api/v1/system` | SO, CPU, RAM, GPUs, backend recomendado, disco |
| GET | `/api/v1/system/live` | RAM/CPU/VRAM em tempo real (monitor) |
| GET | `/api/v1/config` | `{config, editable}` (segredos redigidos) |
| PUT | `/api/v1/config` | atualização parcial validada; devolve `{changed, needsRestart}`; 422 lista os erros |
| GET | `/api/v1/config/api-keys` | impressão digital das chaves (nunca a chave inteira) |
| POST | `/api/v1/config/api-key` `{key?}` | cria/registra uma chave; a resposta é a única vez que ela aparece |
| DELETE | `/api/v1/config/api-key` `{key}` | remove |
| GET | `/api/v1/jobs?history=1&limit=&kind=` · `/jobs/:id` · POST `/jobs/:id/cancel` | fila e histórico (data/jobs.sqlite) |
| GET | `/api/v1/events?topics=job,download.progress,meeting.transcript,project.ingest` | SSE: `event: <tópico>`, `data: <json>` |

## Modelos — pronto
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/v1/models?kind=text&refresh=1` | biblioteca (inspeção por conteúdo, origem, companheiros) |
| GET | `/api/v1/models/recipes` · POST `/recipes/reload` | receitas |
| GET | `/api/v1/models/resolve?ref=<link\|org/repo\|recipe:id>&quant=Q8_0` | plano sem baixar (arquivos, tamanhos, avisos, alternativas) |
| POST | `/api/v1/models/pull` `{ref}` ou `{plan}` | inicia download → `{ job, plan }`; pacotes `.zip`/`.tar.bz2` são extraídos e registrados (MOD-08) |
| GET | `/api/v1/models/search?q=&kind=` | busca no Hugging Face |
| GET | `/api/v1/models/inspect?path=` | o que um arquivo realmente é |
| POST | `/api/v1/models/import` `{path, kind?, move?}` | traz arquivo externo (hardlink/cópia) |
| DELETE | `/api/v1/models?id=<kind/arquivo>` | apaga (só dentro da biblioteca) |
| GET | `/api/v1/models/migrate/scan?source=` · POST `/migrate/import` `{paths}` | migração de instalação antiga |
| GET/PUT | `/api/v1/models/tokens` `{hf, civitai}` | tokens (guardados em `data/secrets`) |

## Motores — pronto
`GET /api/v1/engines` (instalados, rodando, backend preferido) · `POST /engines/adopt` (binários do ULS por hardlink) ·
`POST /engines/:id/install?backend=` (job) · `POST /engines/start` `{model, settings}` · `POST /engines/instances/:id/stop` ·
`POST /engines/stop-all` · `GET/PUT/DELETE /engines/model-settings[/:model]` (ENG-12: ctx, ngl, threads, cache por modelo) ·
`GET /engines/providers` · `PUT /engines/providers/:id/key` `{key}`.

## OpenAI-compatível `/v1` — pronto
`GET /v1/models` (biblioteca + provedores com chave + `running`) · `POST /v1/chat/completions` (stream SSE passthrough) ·
`POST /v1/completions` · `POST /v1/embeddings` · `POST /v1/rerank` ·
`POST /v1/images/generations` `{prompt, model?, size, n, steps, cfg, seed, negative_prompt, response_format}` ·
`POST /v1/images/edits` (multipart: `image`, `mask?`, `prompt`, `strength?`) ·
`POST /v1/audio/speech` `{input, voice?, response_format: wav|mp3|ogg|flac, speed?}` ·
`POST /v1/audio/transcriptions` e `POST /v1/audio/translations`
(multipart `file` em qualquer formato — o ffmpeg converte —, `language?`, `diarize?`,
`timestamp_granularities[]=word`, `response_format: json|text|srt|vtt|verbose_json`).
Campo `model` aceita id da biblioteca (`text/Qwen3-4B-Q4_K_M.gguf`), id de receita, ou `provedor:modelo`
(openai, anthropic, deepseek, openrouter, groq, ollama).

## Geração nativa — pronto
`POST /api/v1/generate/image` `{prompt, model?, negative, width, height, steps, cfg, seed, sampler, initImage, strength, mask}` (job) ·
`POST /api/v1/generate/upscale` `{image, upscaleModel?, repeats?}` (job) ·
`POST /api/v1/generate/video` `{prompt, model?, width, height, frames, fps, initImage?}` (job; quadros → mp4) ·
`GET /api/v1/outputs?kind=image|video|speech|music` (galeria com metadados) · `GET /outputs/file?path=` · `DELETE /outputs/:id`.

## Áudio e vozes — pronto
`GET /api/v1/voices?refresh=1` (pacotes baixados + vozes suas) · `GET /voices/:id` · `POST /voices` · `DELETE /voices/:id` ·
`POST /voices/:id/preview` `{text?}` (devolve WAV) · `POST /voices/clone` (multipart: `name`, `sample`, `cloneEngine?`) ·
`GET /api/v1/audio/devices` (microfones e loopback do sistema) · `GET /api/v1/audio/packages` ·
`POST /api/v1/audio/packages/:id/install` (job: cria o venv com uv) ·
`POST /api/v1/audio/music` `{prompt, lyrics?, durationSec?, engine: musicgen|stableaudio|acestep, seed?}` (job).

## Reuniões — pronto
`GET /api/v1/meetings` · `GET /meetings/devices` · `POST /api/v1/meetings` `{title?, sources: [mic|system], mic?, system?, projectId?, language?}` ·
`GET /meetings/:id` · `POST /meetings/:id/stop` `{summarize?, model?}` · `POST /meetings/:id/to-project` `{projectId}` ·
`GET /meetings/:id/export?format=md|srt|vtt|txt|json` · `DELETE /meetings/:id` · SSE `meeting.transcript` durante a gravação.

## Projetos e documentos — pronto
`GET/POST /api/v1/projects` · `GET/PATCH/DELETE /projects/:id` (apagar move para `data/trash`) ·
`POST /projects/:id/sources` (multipart `file` ou `{paths, move?, ingest?}`) · `GET /projects/:id/sources` ·
`GET /projects/:id/sources/:sid/content` (Markdown extraído) · `GET /sources/:sid/file` (original) · `DELETE /sources/:sid` ·
`POST /projects/:id/ingest` `{sourceIds?, force?}` (job) ·
`POST /projects/:id/search` `{query, k, hybrid, rerank, sourceIds?, docType?}` ·
`POST /projects/:id/ask` `{question, model?, k?, rerank?, chatId?, stream?}` (SSE quando `stream`) ·
`GET /projects/:id/chats[/:chatId]` ·
`GET/POST /projects/:id/memory` · `DELETE /projects/:id/memory/:mid` · `GET/PUT /api/v1/memory` (memória global) ·
`POST /projects/:id/extract` `{sourceIds?, docType?, model?, force?}` (job) · `POST /projects/:id/validate` ·
`POST /projects/:id/crosscheck` `{tablePath, docType}` · `GET /projects/:id/report` ·
`GET/POST /projects/:id/connectors` · `POST /connectors/:cid/sync` (job) · `DELETE /connectors/:cid` ·
`POST /projects/:id/watch` `{folders}` · `DELETE /projects/:id/watch` ·
`GET /api/v1/doctypes[/:id]` · `POST /api/v1/ocr` (multipart `file` ou `{paths, model?, prompt?}`; job) ·
`GET /api/v1/ocr/:jobId/result?format=json|md|csv`.

## MCP — pronto
`POST /mcp` (JSON-RPC 2.0, streamable HTTP). `initialize`, `tools/list`, `tools/call`, `ping`.
Ferramentas: `chat`, `list_models`, `download_model`, `generate_image`, `generate_video`, `speak`, `list_voices`,
`transcribe`, `ocr_file`, `list_projects`, `search_project`, `ask_project`, `read_document`, `extract_fields`,
`validate_document`, `check_against_table`. Falha de ferramenta volta como conteúdo com `isError: true`
(o agente precisa ler o motivo); método desconhecido volta como erro JSON-RPC.
O `agent/settings.yaml` já registra este servidor para o dsh embutido.

## Agente — pronto
`GET /api/v1/agent` (estado) · `POST /agent/install` (job, pnpm) · `POST /agent/start` (sobe `dsh web`, responde quando pronto) ·
`POST /agent/stop` · `GET /agent/settings` (regrava `agent/settings.yaml`) · `POST /agent/run` `{task, workspace?}` (job headless).
A UI do dsh fica em `state.url` (3080) e é embutida na aba Agente.

## Serviço — pronto (CLI)
`aistudio service install|uninstall|status|start|stop|logs` — Windows (schtasks no logon), macOS (LaunchAgent),
Linux (systemd --user). Sem endpoint HTTP: instalar serviço é decisão da máquina, não da rede.
