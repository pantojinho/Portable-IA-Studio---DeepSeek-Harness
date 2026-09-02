# AI Studio — Plano de construção (v2)

Estúdio de IA local, portátil (Windows / macOS / Linux), leve, que roda qualquer tipo de modelo
(texto, imagem, vídeo, fala, música, OCR), com **projetos de documentos** (OCR + memória + RAG),
um agente de código integrado (DeepSeek Harness), APIs padrão OpenAI para outros programas usarem,
e modo "serviço fixo" opcional.

Base: `techjarves/Uncensored-Local-Studio` (motores + UI) + `deepseek-ai/deepseek-harness` (agente).
Prioridade declarada por você: **Áudio/TTS ampliado** e **Documentos (OCR + RAG + projetos)**.

---

## 1. O que foi encontrado (diagnóstico)

### 1.1 Uncensored-Local-Studio (ULS) — em `D:\AI Studio\Uncensored-Local-Studio-main`

| Peça | Como é hoje | Tamanho |
|---|---|---|
| Servidor | 1 arquivo `scripts/server/serve.cjs` com 7.275 linhas (Node.js, sem framework) | 1 MB |
| UI | React + Vite (`app/frontend`), 8 componentes | 94 MB (node_modules) |
| Runtime | Node.js 22.12 portátil em `app/tools/node-win` | 97 MB |
| Texto | llama.cpp `llama-server` (cpu + cuda, com 40 executáveis extras que a app não usa) | 1,6 GB |
| Imagem | stable-diffusion.cpp `sd-cli`/`sd-*.exe` (cpu + cuda + vulkan) | 1,3 GB |
| Fala→texto | whisper.cpp | 20 MB |
| Texto→fala | **só Kokoro** (kokoro-js + onnxruntime), sem clonagem de voz, sem outros motores | 498 MB |
| Documentos / OCR / RAG | **não existe** | — |
| Música / reuniões | **não existe** | — |

Reaproveitamos: detecção de GPU, supervisão dos motores, troca automática de porta, catálogo de backends
por SO (`scripts/config/llm-backends.json`), proxy `/v1/*` para o llama-server e os componentes React.

### 1.2 Por que o download automático "não funciona" (causa raiz confirmada)

A função `startModelDownload` em `serve.cjs:5145`:

1. Pega a URL colada, troca `/blob/` por `/resolve/` e **assume que é um arquivo**.
2. Usa o último pedaço do caminho como nome do arquivo.
3. Grava no disco **qualquer coisa que o servidor devolver**, sem checar `Content-Type` nem o conteúdo.

Quando você cola a URL da **página do repositório**, ele salva o HTML como se fosse o modelo. Evidência em `app/models/`:

| Arquivo | Tamanho | Conteúdo real |
|---|---|---|
| `FLUX.2-klein-4B` | 205 KB | `<!doctype html>` (página do HF) |
| `Z-Image-Turbo` | 280 KB | `<!doctype html>` |
| `stable-diffusion-3.5-medium` | 279 KB | `<!doctype html>` |
| `flux2-klein-4b-uncensored-text-encoder` | 284 KB | `<!doctype html>` |
| `Não confirmado *.crdownload` (2 arquivos) | 2,8 GB | tentativa manual pelo Chrome, não terminou |

Outros defeitos do mesmo módulo: um download por vez, sem fila, sem retomada, sem hash; não sabe baixar
modelos de vários arquivos (Flux.2, SD3.5, Z-Image, Wan, LTX), embora o `sd-cli.exe` bundled já aceite
`--diffusion-model`, `--vae`, `--llm`, `--t5xxl` e o modo `vid_gen`; não classifica por conteúdo
(um GGUF do Flux.2 de 4,3 GB foi parar em `llm-models/`, um `model.safetensors` de 2,4 GB em `tts-models/`);
sem campo de token do Hugging Face para modelos com login.

### 1.3 DeepSeek Harness (dsh)

- Node ≥ 22.19 ou 24, TypeScript, framework de plugins **Cordis**, MIT. npm `@deepseek-ai/dsh` v0.1.1-rc.2.
- "Developer preview": **haverá mudanças incompatíveis**. Versão será fixada.
- Modos: `dsh web` (UI 127.0.0.1:3080), `headless` (uma tarefa e sai), `sdk` (JSON-RPC, SDK TS e **Python**), `acp`.
- Ferramentas: bash, pwsh, terminal persistente, arquivos, web fetch/search, sub-agentes, plano, jobs, agendador, cliente **MCP**.
- Sandbox: `sandbox-windows-acl`, `landlock` (Linux), aprovação por ferramenta.
- Provedor customizado **OpenAI-compatível** via `settings.yaml` (`baseURL`, `compat.maxTokensField: max_tokens`,
  `compat.supportsDeveloperRole: false`) → fala direto com o nosso llama-server local.

### 1.4 OCR: GLM-OCR roda no mesmo motor de texto

`zai-org/GLM-OCR` (o link que você mandou): 0,9B parâmetros, encoder CogViT + decoder GLM-0.5B, MIT.
Faz texto, tabelas, fórmulas, layout e **extração por JSON schema**. 1º lugar no OmniDocBench v1.5.
Existe GGUF oficial `ggml-org/GLM-OCR-GGUF` e roda no `llama-server` com `--mmproj` — **sem Python**.
Alternativas no mesmo caminho: DeepSeek-OCR-2 (GGUF), e para lote rápido RapidOCR/PP-OCRv5 (onnx, minúsculo).

### 1.5 Bônus: `colibri` na pasta

`colibri-v1.10.1` (JustVugg/colibri, Apache-2.0): roda MoE gigantes (GLM-5.2, DeepSeek V4, Kimi K3, Qwen 3.6/3.8)
do SSD com 15–26 GB de RAM, API OpenAI-compatível, precisa de Python. Motor opcional.

### 1.6 Máquina de desenvolvimento

RTX A1000 6 GB, 32 GB RAM, i7-13800H, 539 GB livres. Node 24.19, Python 3.13, uv, git. Sem pnpm, sem Docker.
Os 6 GB de VRAM são a régua do modo leve.

---

## 2. Decisões de arquitetura

| Decisão | Escolha | Por quê |
|---|---|---|
| Servidor | TypeScript compilado em **um único `server.cjs`** (esbuild) | Zero `npm install` no cliente; funciona de pendrive/exFAT; acaba o malabarismo de `node_modules_<so>` do ULS. |
| Runtime | **Node 24 LTS portátil** (≈50 MB), baixado no 1º start ou já no zip | Um runtime serve Studio + dsh. Nada instalado no sistema. |
| Python | **Opcional**, só para motores que exigem (clonagem de voz avançada, música, colibri, NPU). `uv` numa venv dentro da pasta | Núcleo leve. Tudo que dá para fazer em GGUF/ONNX vem primeiro. |
| Motores | Binários oficiais baixados **sob demanda, só a variante da sua GPU** | ULS carrega 3 GB de variantes; aqui núcleo ≈70 MB + motores ≈400–700 MB. |
| OCR | **llama.cpp + GGUF** (GLM-OCR, DeepSeek-OCR-2) como padrão; RapidOCR onnx para lote | Reaproveita o motor de texto, zero dependência extra. |
| Documentos / RAG | **SQLite** por projeto (`sqlite-vec` para vetores + `FTS5` para texto) | Um arquivo por projeto = portátil, copiável, sem servidor de banco. Cresce depois para Postgres se precisar. |
| Embeddings / rerank | GGUF via llama.cpp `--embedding` (Qwen3-Embedding-0.6B, bge-m3, e5-small) e reranker GGUF | Modelos pequenos, multilíngues, PT-BR bom, rodam em CPU. |
| Vozes | **Registro unificado de vozes**: voz = motor + modelo + amostra. Motores sem Python primeiro | Trocar de motor não muda a UI nem a API `/v1/audio/speech`. |
| Agente | **dsh embutido** como filho supervisionado, versão fixada, `DSH_HOME` na pasta | Herdamos UI, ferramentas, sandbox, MCP, SDK Python. |
| Interface | React + Vite, navegação como nas suas telas (Novo chat · Projetos · Hub de modelos · …) | Um produto só; aba Agente embute o dsh. |
| APIs | `/v1` OpenAI + `/api/v1` nativa (jobs, SSE) + **servidor MCP** | Cursor, Claude Code, Open WebUI, scripts usam o Studio como backend. |
| Serviço fixo | `aistudio service install` → Task Scheduler / launchd / systemd --user | Sem admin obrigatório. |
| Dados | Tudo relativo à pasta do Studio; `--data-dir` opcional | Copiar a pasta = mover a instalação. |
| Acesso remoto | Mesmo servidor com `--host` + `--api-key`; UI é PWA (funciona no celular) | "Subir pra web depois" = colocar atrás de um proxy reverso, sem mudar código. |

Nome de trabalho: **AI Studio**. Comando `aistudio` (`start.bat` / `start.command` / `start.sh`).

---

## 3. Estrutura do projeto

```
AI Studio/
├── start.bat  start.command  start.sh   # 1º start: baixa runtime + motor da sua GPU
├── aistudio.cmd / aistudio               # CLI: serve | service | models | engines | agent | projects | doctor
├── runtime/node/<os-arch>/               # Node 24 portátil
├── engines/<motor>/<os>/<gpu>/           # llama.cpp, sd.cpp, whisper.cpp, onnxruntime, ffmpeg, [venv-python]
├── models/
│   ├── text/  image/  video/  speech/  tts/  music/  ocr/  embeddings/  rerank/
│   └── recipes/                          # receitas de modelos multi-arquivo e de vozes
├── projects/<nome>/                      # 1 pasta por projeto (portátil)
│   ├── sources/                          # arquivos originais (PDF, DOCX, imagens, áudio…)
│   ├── derived/                          # texto extraído (.md), OCR (.json), transcrições
│   ├── index.sqlite                      # chunks + vetores (sqlite-vec) + FTS5 + campos extraídos
│   ├── memory.md                         # memória do projeto (fatos, resumo, glossário) — editável
│   └── chats/                            # conversas do projeto
├── voices/<id>/                          # amostras e configs de vozes (clonagem)
├── data/                                 # config.yaml, jobs.sqlite, outputs/, recordings/, logs/, secrets/
├── agent/                                # DSH_HOME: settings.yaml (provedor "local"), perfis, plugins
├── server/  (TypeScript → dist/server.cjs)
│   ├── core/        paths, config, portas, supervisor, planejador de VRAM, eventos, jobs
│   ├── engines/     adaptadores: llamacpp, sdcpp, whispercpp, onnx-tts, ffmpeg, python-venv, colibri
│   ├── models/      registro, resolvedor HF/CivitAI/URL, downloader, receitas, classificação por header
│   ├── audio/       vozes, TTS, STT, diarização, reuniões, música
│   ├── documents/   ingestão, OCR, chunking, embeddings, busca híbrida, extração, validadores, conectores
│   ├── api/         /v1, /api/v1, /mcp, API keys
│   ├── agent/       supervisor do dsh, ponte JSON-RPC, MCP-bridge "studio-tools"
│   └── service/     install/uninstall Win/mac/Linux
├── web/  (React + Vite → dist/)
└── packaging/                            # zips por SO, GitHub Actions
```

---

## 4. Módulos em detalhe

### 4.1 Gerenciador de modelos v2 (conserta o download)

Aceita qualquer referência e resolve para arquivos antes de baixar: página de repo do HF, `/blob`, `/resolve`,
`/tree`, `hf://org/repo/arquivo`, `org/repo:Q4_K_M`, CivitAI, URL direta. Token HF opcional (modelos com login).

Downloader: fila paralela, chunks paralelos, **retomada** por `Range`, `.part` + rename atômico, sha256 do LFS conferido.

**Validação antes de aceitar** (onde o bug morre): `text/html` é rejeitado com a lista dos arquivos reais;
primeiros bytes classificam o tipo (GGUF, safetensors, ggml, onnx, zip); o header revela a arquitetura
(llama, qwen3, flux2, wan, clip, vae, glm-ocr…) e o arquivo vai para a **pasta certa sozinho**.

**Receitas** (`models/recipes/*.yaml`): o que baixar + flags do motor. Prontas: Flux.2 klein 4B, Flux.1, SD3.5,
Z-Image Turbo, Qwen-Image, Wan 2.1/2.2, LTX-2, SDXL/SD1.5, Whisper (tiny→large-v3-turbo), GLM-OCR + mmproj,
DeepSeek-OCR-2, Qwen3-Embedding, bge-m3, bge-reranker, Kokoro, Piper PT-BR, OuteTTS, famílias GGUF de texto.

Migração: no 1º start detecta as pastas do ULS, reaproveita os 28 GB de modelos e os binários, e aponta os
arquivos falsos para você apagar. **O Studio nunca apaga nada sozinho.**

### 4.2 Motores (adaptadores)

Interface única: `capabilities()`, `install(variant)`, `start(model, opts)`, `stop()`, `health()`, `run(job)`.

| Motor | Modalidades | Python? | Fase |
|---|---|---|---|
| llama.cpp `llama-server` | chat, completions, **embeddings**, visão, **OCR (GLM-OCR / DeepSeek-OCR-2)**, tool-calling, JSON por grammar, **OuteTTS** | não | 2 |
| stable-diffusion.cpp | txt2img, img2img, inpaint, upscale, ControlNet, LoRA, vídeo (`vid_gen`: Wan/LTX/AnimateDiff) | não | 2 / 7 |
| whisper.cpp | transcrição, tradução, streaming, diarização (tinydiarize) | não | 3 |
| onnxruntime-node | Kokoro, **Piper**, RapidOCR/PP-OCRv5, segmentação de falantes (sherpa-onnx) | não | 3 |
| ffmpeg portátil | captura de mic + áudio do sistema, conversão, corte, mux de vídeo | não | 3 |
| Python-venv (uv) | **Chatterbox / XTTS-v2 / F5-TTS** (clonagem de voz), **ACE-Step / MusicGen** (música), Stable Audio Open (efeitos), pyannote (diarização premium), unsloth/kohya (treinar), NPU/CoreML | sim, opcional | 3 (voz) / 9 |
| colibri | LLMs MoE gigantes do SSD | sim, opcional | 9 |

Supervisor: arranque sob demanda, descarga após inatividade, planejador de VRAM. Em 6 GB: Qwen3 4B Q4 + Piper + GLM-OCR
cabem juntos; Flux.2 ou ACE-Step exigem descarregar o LLM.

### 4.3 Áudio (prioridade)

**Vozes (TTS).** Uma tela "Vozes": cada voz = motor + modelo + idioma + (opcional) amostra de 10–30 s para clonagem.
Botão "ouvir", voz padrão por idioma, exposta em `/v1/audio/speech` com `voice=<id>`.

| Motor | Tipo | Peso | Clonagem | PT-BR | Como roda |
|---|---|---|---|---|---|
| Piper | neural leve | 20–60 MB por voz | não | sim, várias vozes | onnx, CPU, instantâneo |
| Kokoro 82M | qualidade alta | 300 MB | não | sim | onnx |
| OuteTTS | LLM-TTS | ~1 GB GGUF | **sim** (amostra curta) | sim | llama.cpp |
| Chatterbox | clonagem expressiva | ~2 GB | **sim** | multilíngue | venv Python |
| XTTS-v2 | clonagem clássica | ~2 GB | **sim** | sim | venv Python |
| F5-TTS | clonagem por fluxo | ~1,5 GB | **sim** | via fine-tune PT | venv Python |

Ordem: Piper e Kokoro no núcleo (zero Python), OuteTTS logo depois, clonagem premium pela venv opcional.

**Fala → texto (STT).** whisper.cpp com large-v3-turbo (qualidade) e small (velocidade), VAD, timestamps por palavra,
diarização (tinydiarize ou sherpa-onnx), tradução. `/v1/audio/transcriptions` compatível.

**Reuniões.** Gravar **microfone + áudio do sistema** (Windows: WASAPI loopback via ffmpeg; macOS: BlackHole/ScreenCapture;
Linux: PulseAudio monitor; ou pelo navegador via compartilhamento de tela com áudio). Transcrição ao vivo,
identificação de falantes, e ao final: resumo, decisões, ações, perguntas abertas (LLM local).
Exporta `.md`/`.docx`/`.srt`, e a reunião **entra automaticamente no projeto escolhido** como fonte do RAG.

**Música e sons.** ACE-Step (letra + estilo → música completa; roda em 6 GB com offload), MusicGen small
(trechos instrumentais), Stable Audio Open small (efeitos sonoros). Via venv Python, instalados sob demanda.
Endpoint nativo `/api/v1/audio/music`.

### 4.4 Projetos e Documentos (prioridade)

Segue as telas que você mandou: **Projetos** com "Criar projeto → nome + Fontes (arquivos que todo chat do projeto pode ler)".

**Ingestão** (fila com progresso):

| Entrada | Como extrai |
|---|---|
| PDF com texto | camada de texto (pdf.js) + layout → Markdown |
| PDF escaneado, imagens, fotos de documento | **OCR**: GLM-OCR (padrão; tabelas, fórmulas, layout) ou RapidOCR (lote rápido) |
| DOCX / XLSX / PPTX | parsers Node (mammoth, xlsx, pptx) → Markdown/tabelas |
| TXT / MD / HTML / CSV / JSON | direto |
| E-mail (.eml/.msg) | cabeçalhos + corpo + anexos (recursivo) |
| Áudio / vídeo | whisper → transcrição com falantes |
| Pasta monitorada | reingere quando arquivos mudam |

**Índice.** Chunking por estrutura (títulos, tabelas inteiras, parágrafos), embeddings GGUF (Qwen3-Embedding-0.6B ou
bge-m3, ambos ótimos em PT), gravados em `index.sqlite` (**sqlite-vec** + **FTS5**). Busca híbrida (vetor + palavra-chave)
+ reranker GGUF. Resposta sempre com **citações** (documento, página, trecho) e visualização do trecho original.

**Memória.** `memory.md` por projeto: resumo, glossário, fatos-chave extraídos na ingestão, e o que você marcar como
"lembrar". Injetada como contexto nos chats do projeto e disponível ao agente. Também uma memória global (perfil, preferências).
Modelos pequenos (0,5–4B) fazem extração e classificação; o modelo grande recebe só o que a busca trouxe.

**Tela OCR dedicada.** Arrastar arquivos → prévia da página com as caixas detectadas ao lado do texto/Markdown editável →
exportar `.md`, `.txt`, `.json`, `.csv`/`.xlsx` (tabelas), lote inteiro de uma vez. Escolha do motor e do idioma.

**Extração estruturada e validação** (seu exemplo da nota fiscal):
- **Tipos de documento** com esquema JSON: NF-e / NFS-e, recibo, boleto, contrato, fatura, extrato, currículo… (extensível).
- Classificação automática (modelo pequeno) → extração de campos com JSON schema (GLM-OCR suporta nativamente; llama.cpp
  força o formato por grammar) → **validadores** em código: chave de acesso NF-e (44 dígitos + dígito verificador mod 11),
  CNPJ/CPF, soma dos itens = total, datas coerentes, duplicidade, CFOP/NCM plausíveis.
- **Conferência com tabela**: importa CSV/XLSX (ex.: pedidos, lançamentos SAP) e responde "bate?" por documento,
  com relatório de divergências (valor, fornecedor, data, número).
- **Conectores** como interface plugável: pastas, e-mail (IMAP), e no futuro SAP (OData), ERP, Google Drive.

**Harness melhor para documentos.** O agente dsh recebe, via MCP, as ferramentas `search_project`, `read_document`,
`ocr_file`, `extract_fields`, `validate_document`, `check_against_table`. Um fluxo pronto "Conferir lote": classificar →
extrair → validar → cruzar → relatório.

### 4.5 APIs

- **OpenAI-compatível** (`/v1`): `chat/completions` (stream), `completions`, `embeddings`, `models`, `images/generations`,
  `images/edits`, `audio/speech` (com `voice=<id>` do registro), `audio/transcriptions`, `audio/translations`.
- **Nativa** (`/api/v1`): `jobs` (SSE), `video/generations`, `audio/music`, `ocr`, `projects` (criar, fontes, ingestão,
  busca, perguntar, extrair, validar), `meetings`, `voices`, `models`, `engines`, `system`, `agent`, `outputs`.
- **MCP** (`/mcp`): `chat`, `generate_image`, `generate_video`, `speak`, `transcribe`, `ocr_file`, `search_project`,
  `read_document`, `extract_fields`, `validate_document`, `list_models`, `download_model`.
- Segurança: `127.0.0.1` por padrão; `--host 0.0.0.0` + `--api-key`; CORS; rate-limit; dsh nunca exposto sem chave.

### 4.6 Agente (dsh embutido)

- `agent/` é o `DSH_HOME`; `settings.yaml` com provedor `local` → `/v1` do Studio, e provedores em nuvem opcionais.
- `dsh web --no-open` como filho supervisionado, embutido na aba **Agente**; trocar modelo no Studio troca no agente.
- Ponte MCP: o agente cria páginas, código, imagens, vídeo, áudio e consulta os projetos na mesma sessão, com sandbox
  e aprovação por ação, no workspace escolhido (que pode ser a pasta de um projeto).
- `aistudio agent run "tarefa"` e `/api/v1/agent` para automação (headless / SDK Python).
- Versão fixada; camada `server/agent/` isola o Studio de mudanças do preview.

### 4.7 Interface

Navegação lateral (como nas suas telas): **Novo chat** · **Projetos** · **Documentos & OCR** · **Hub de modelos** ·
**Imagens** · **Vídeo** · **Áudio** (Vozes, Música) · **Reuniões** · **Agente** · **Treinar** (futuro) · **APIs** · **Configurações**.
Recentes na lateral; monitor de CPU/RAM/GPU/VRAM sempre visível; PT/EN; PWA (abre no celular pela rede).

### 4.8 Modo serviço

`aistudio service install [--host 0.0.0.0] [--api-key X] [--port N]` → Windows: tarefa agendada ao iniciar sessão
(sem admin) ou serviço `sc` (com admin); macOS: LaunchAgent com KeepAlive; Linux: systemd --user.
`status|start|stop|uninstall|logs`. `--headless` sem abrir navegador.

### 4.9 Empacotamento

| Pacote | Conteúdo | Tamanho |
|---|---|---|
| zip por SO (win-x64, mac-arm64, linux-x64) | launchers + `server.cjs` + web + Node portátil | ≈ 70–90 MB |
| 1º start | motor de texto + imagem para **sua** GPU | ≈ 400–700 MB |
| Sob demanda | whisper, Piper/Kokoro, onnxruntime, ffmpeg, GLM-OCR (~1 GB), embeddings (~600 MB), dsh, venv Python | conforme uso |

GitHub Actions monta os três pacotes a cada tag; versão "tudo offline" separada.

### 4.10 Futuro (esqueleto previsto, não construído agora)

- **Persona**: voz clonada (Chatterbox/XTTS a partir de 30 s seus), estilo de escrita aprendido dos seus e-mails (RAG),
  conector IMAP/SMTP com **rascunho → sua aprovação → envio** (nunca envia sozinho por padrão), avatar em vídeo com
  lip-sync (MuseTalk/LatentSync, pesado, opcional). Tudo local e portátil.
- **Treinar**: LoRA de imagem (kohya/sd-scripts) e de LLM (unsloth) pela venv; em 6 GB só modelos pequenos.
- **colibri** para modelos MoE gigantes; **Tauri** para janela nativa + bandeja.

---

## 5. Fases de execução

| Fase | Entrega | Critério de pronto | Estimativa |
|---|---|---|---|
| **0. Fundação** | Esqueleto TS + esbuild, launchers 3 SO, Node portátil, config, logs, jobs, `aistudio doctor` | `start.bat` abre uma página em máquina limpa sem instalar nada | 1 dia |
| **1. Modelos** | Gerenciador v2 (resolvedor, downloader, validação, receitas, migração do ULS) | URL da página do FLUX.2-klein baixa a receita certa; HTML rejeitado; teste com os 4 casos reais | 2–3 dias |
| **2. Texto + Imagem + /v1** | llama.cpp e sd.cpp, supervisor, planejador de VRAM, API OpenAI | `curl /v1/chat/completions` e `/v1/images/generations`; Open WebUI conecta | 3 dias |
| **3. Áudio** | whisper + diarização, registro de vozes (Piper, Kokoro, OuteTTS), gravação de reuniões com resumo, `/v1/audio/*`; clonagem e música pela venv | Reunião gravada, transcrita com falantes e resumida; 3 motores de voz na mesma tela; clonar sua voz com OuteTTS | 3–4 dias |
| **4. Projetos + Documentos** | Projetos com fontes, ingestão (PDF/DOCX/XLSX/imagens/áudio), OCR GLM-OCR, índice SQLite híbrido, chat com citações, memória, tela OCR, tipos de documento, extração + validação, conferência com tabela | Subir 50 notas fiscais escaneadas → classificar, extrair, validar chave/CNPJ/total, cruzar com um XLSX e gerar relatório; perguntar "quais vencem este mês?" com citações | 4–5 dias |
| **5. Interface completa** | Todas as abas, recentes, galeria, monitor, PT/EN, PWA | Fluxo inteiro sem terminal, inclusive no celular pela rede | 3 dias |
| **6. Agente** | dsh embutido, provedor local, MCP-bridge com ferramentas de projeto, sandbox, headless | "Confira este lote de notas contra a planilha e gere o relatório" e "crie uma landing page com imagem de capa" ponta a ponta | 2–3 dias |
| **7. Vídeo** | `vid_gen` (Wan 2.2 / LTX-2), upscale, prévia de frames | Clipe de 2 s na A1000 | 2 dias |
| **8. APIs + Serviço + Release** | API keys, LAN, servidor MCP, `service install`, docs, CI com zips | Como serviço no Windows, acessado de outro PC; Claude Code usa o `/mcp` | 2 dias |
| **9. Futuro** | Persona, Treinar, colibri, música avançada, Tauri | — | conforme demanda |

Núcleo (fases 0–8): ≈ 5 semanas de trabalho contínuo. Cada fase termina rodando e testável por você.

---

## 6. Riscos e tratamento

- **dsh muda a API** → versão fixada, camada isolada, teste de fumaça no CI.
- **6 GB de VRAM** → planejador + offload; receitas com requisito mínimo; embeddings/OCR/Piper rodam em CPU se preciso.
- **Qualidade do OCR em PT-BR** → GLM-OCR é multilíngue mas será medido com seus documentos reais; RapidOCR como reserva;
  texto editável na tela para corrigir.
- **Captura do áudio do sistema** difere por SO → ffmpeg portátil com perfis por SO + fallback pelo navegador.
- **Clonagem de voz e persona** → só com sua própria voz/consentimento explícito; nenhum envio automático de e-mail sem aprovação.
- **Binários por SO/GPU** → catálogo com hash, fallback CPU.
- **Antivírus** → releases oficiais do GitHub, hash conferido, documentado.
- **Licenças** → ULS MIT, dsh MIT, GLM-OCR MIT, colibri Apache-2.0, llama.cpp/sd.cpp/whisper.cpp MIT, Piper MIT, Kokoro Apache-2.0.
  Alguns modelos de voz/música têm licença não-comercial (XTTS CPML, ACE-Step Apache mas alguns pesos restritos) — marcado na receita.

---

## 7. Limpeza recomendada (você decide, nada é apagado automaticamente)

Em `Uncensored-Local-Studio-main/app/`: os 4 arquivos HTML em `models/`; os 2 `.crdownload` (2,8 GB);
`tts-models/model.safetensors` (2,4 GB, não é TTS); `llm-models/flux2-klein-4b-uncensored-q8_0.gguf` (4,3 GB, é difusor
do Flux.2 — a migração move para `models/image/`).

---

## 8. Próximo passo

Começar **Fase 0 + Fase 1** em `D:\AI Studio\aistudio\` (pasta nova; os projetos originais ficam intocados como referência).
Primeira coisa visível: o gerenciador de modelos funcionando com as mesmas URLs que falharam. Em seguida, Fase 3 (Áudio)
e Fase 4 (Projetos + Documentos) por serem sua prioridade.
