# API do AI Studio

Base: `http://127.0.0.1:1420`. Sem autenticação em localhost; com `--api-key`, envie
`Authorization: Bearer <chave>` (ou `X-Api-Key`). Erros: `{ "error": "mensagem" }`.
Status por endpoint: **pronto** · *planejado (ID da tarefa)*.

## Núcleo — pronto
| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/v1/health` | versão e uptime |
| GET | `/api/v1/system` | SO, CPU, RAM, GPUs, backend recomendado, disco |
| GET | `/api/v1/system/live` | RAM/CPU/VRAM em tempo real (monitor) |
| GET | `/api/v1/config` | configuração (segredos redigidos) |
| GET | `/api/v1/jobs` · `/jobs/:id` · POST `/jobs/:id/cancel` | fila de trabalhos |
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

## Motores — *ENG-09*
`GET /api/v1/engines` (instalados, rodando, VRAM) · `POST /engines/:id/install` · `POST /engines/:id/start`
`{model, settings}` · `POST /engines/instances/:id/stop` · `GET /engines/catalog`.

## OpenAI-compatível `/v1` — *ENG-06/07/08, AUD-01/02*
`GET /v1/models` · `POST /v1/chat/completions` (stream SSE) · `POST /v1/completions` · `POST /v1/embeddings`
· `POST /v1/images/generations` `{prompt, model, size, n, response_format}` · `POST /v1/images/edits` ·
`POST /v1/audio/speech` `{input, voice, response_format}` · `POST /v1/audio/transcriptions` (multipart) ·
`POST /v1/audio/translations`. Campo `model` aceita id da biblioteca (`text/Qwen3-4B-Q4_K_M.gguf`) ou id de receita.

## Geração nativa — *ENG-10, VID-01, AUD-09*
`POST /api/v1/generate/image` (todas as opções do sd.cpp; job) · `POST /api/v1/generate/video` ·
`POST /api/v1/audio/music` · `GET /api/v1/outputs` (galeria com metadados) · `DELETE /api/v1/outputs/:id`.

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

## Agente — *AGT-01…AGT-05*
`GET /api/v1/agent` (estado) · `POST /agent/install` · `POST /agent/start|stop` · `POST /agent/run` `{task, workspace}` ·
`GET /api/v1/agent/settings` · `PUT /agent/settings`. UI do dsh servida em `http://127.0.0.1:3080` e embutida na aba Agente.

## MCP — *AGT-04*
`POST /mcp` (streamable HTTP). Ferramentas: `chat`, `generate_image`, `generate_video`, `speak`, `transcribe`, `ocr_file`,
`search_project`, `read_document`, `extract_fields`, `validate_document`, `check_against_table`, `list_models`, `download_model`.

## Serviço — *SVC-01*
`aistudio service install|uninstall|status|start|stop|logs` (CLI). Sem endpoint HTTP.
