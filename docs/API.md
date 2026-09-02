# API do AI Studio

Base: `http://127.0.0.1:1420`. Sem chave, o servidor só escuta em 127.0.0.1. Havendo qualquer chave
(`--api-key`, `data/secrets/api_keys` ou `aistudio config keys new`), toda chamada a `/api` e `/v1`
exige `Authorization: Bearer <chave>` (ou `X-Api-Key`, ou `?api_key=`). Servir em `--host` público
sem chave é recusado na largada. `server.rateLimitPerMinute` (0 = sem limite) devolve 429 com `Retry-After`.
Erros: `{ "error": "mensagem" }`.
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
| GET | `/api/v1/events?topics=job,download.progress` | SSE: `event: <tópico>`, `data: <json>` |

## Modelos — pronto
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/v1/models?kind=text&refresh=1` | biblioteca (inspeção por conteúdo, origem, companheiros) |
| GET | `/api/v1/models/recipes` · POST `/recipes/reload` | receitas |
| GET | `/api/v1/models/resolve?ref=<link|org/repo|recipe:id>&quant=Q8_0` | plano sem baixar (arquivos, tamanhos, avisos, alternativas) |
| POST | `/api/v1/models/pull` `{ref}` ou `{plan}` | inicia download → `{ job, plan }` |
| GET | `/api/v1/models/search?q=&kind=` | busca no Hugging Face |
| GET | `/api/v1/models/inspect?path=` | o que um arquivo realmente é |
| POST | `/api/v1/models/import` `{path, kind?, move?}` | traz arquivo externo (hardlink/cópia) |
| DELETE | `/api/v1/models?id=<kind/arquivo>` | apaga (só dentro da biblioteca) |
| GET | `/api/v1/models/migrate/scan?source=` · POST `/migrate/import` `{paths}` | migração de instalação antiga |
| GET/PUT | `/api/v1/models/tokens` `{hf, civitai}` | tokens (guardados em `data/secrets`) |

## Motores — pronto
`GET /api/v1/engines` (instalados, rodando, backend preferido) · `POST /engines/adopt` (binários do ULS por hardlink) ·
`POST /engines/:id/install?backend=` (job) · `POST /engines/start` `{model, settings}` · `POST /engines/instances/:id/stop` ·
`POST /engines/stop-all` · `GET /engines/providers` · `PUT /engines/providers/:id/key` `{key}`.

## OpenAI-compatível `/v1` — pronto (mínimo)
`GET /v1/models` (biblioteca + provedores com chave + `running`) · `POST /v1/chat/completions` (stream SSE passthrough) ·
`POST /v1/completions` · `POST /v1/embeddings` · `POST /v1/rerank` · `POST /v1/images/generations`
`{prompt, model?, size, n, steps, cfg, seed, negative_prompt, response_format: b64_json|url}` ·
`POST /v1/audio/transcriptions` (multipart `file` WAV 16 kHz, `model?`, `language?`, `response_format: json|text|srt|verbose_json`).
Campo `model` aceita id da biblioteca (`text/Qwen3-4B-Q4_K_M.gguf`), id de receita, ou `provedor:modelo` (openai, anthropic, deepseek, openrouter, groq, ollama).
Planejados: `/v1/images/edits` (ENG-05b) · `/v1/audio/speech` (AUD-02) · `/v1/audio/translations` (AUD-01).

## Geração nativa — pronto (mínimo)
`POST /api/v1/generate/image` `{prompt, model?, negative, width, height, steps, cfg, seed, sampler, initImage, strength, mask}` (job) ·
`GET /api/v1/outputs` (galeria com metadados) · `GET /outputs/file?path=` · `DELETE /outputs/:id`.
Planejados: `POST /api/v1/generate/video` (VID-01) · `POST /api/v1/audio/music` (AUD-09).

## Agente — pronto (mínimo)
`GET /api/v1/agent` (estado) · `POST /agent/install` (job, pnpm) · `POST /agent/start` (sobe `dsh web`, responde quando pronto) ·
`POST /agent/stop` · `GET /agent/settings` (regrava `agent/settings.yaml`) · `POST /agent/run` `{task, workspace?}` (job headless).
A UI do dsh fica em `state.url` (3080) e é embutida na aba Agente.

## Vozes e reuniões — *AUD-02, AUD-08*
`GET/POST /api/v1/voices` · `POST /voices/:id/preview` · `DELETE /voices/:id` · `POST /voices/clone` (multipart: sample) ·
`POST /api/v1/meetings` (iniciar: `{title, sources, projectId}`) · `POST /meetings/:id/stop` · `GET /meetings` · `GET /meetings/:id`
· SSE `meeting.transcript` · `GET /meetings/:id/export?format=md|docx|srt`.

## Projetos e documentos — *DOC-01…DOC-10*
`GET/POST /api/v1/projects` · `GET/PATCH/DELETE /projects/:id` · `POST /projects/:id/sources` (multipart ou `{paths}`) ·
`GET /projects/:id/sources` · `DELETE /projects/:id/sources/:sid` · `POST /projects/:id/ingest` (job) ·
`POST /projects/:id/search` `{query, k, hybrid, rerank}` · `POST /projects/:id/ask` `{question, model}` (stream) ·
`GET/POST/DELETE /projects/:id/memory` · `POST /projects/:id/extract` `{sourceIds, docType?}` ·
`POST /projects/:id/validate` · `POST /projects/:id/crosscheck` `{tablePath, docType}` ·
`GET /api/v1/doctypes` · `POST /api/v1/ocr` (multipart; job) · `GET /ocr/:jobId/result?format=md|json|csv`.

## MCP — *AGT-04*
`POST /mcp` (streamable HTTP). Ferramentas: `chat`, `generate_image`, `generate_video`, `speak`, `transcribe`, `ocr_file`,
`search_project`, `read_document`, `extract_fields`, `validate_document`, `check_against_table`, `list_models`, `download_model`.

## Serviço — *SVC-01*
`aistudio service install|uninstall|status|start|stop|logs` (CLI). Sem endpoint HTTP.
