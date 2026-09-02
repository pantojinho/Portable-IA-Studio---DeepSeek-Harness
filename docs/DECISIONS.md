# Decisões de arquitetura (ADR curto)

Formato: data · decisão · por quê · consequências. Adicione no topo. Mudar um contrato em
`server/src/*/types.ts` exige uma entrada aqui.

## 2026-09-02 · Extratores de documento escritos aqui, sem pdfjs/mammoth/xlsx/jszip
Por quê: DOCX, XLSX e PPTX são ZIP+XML e o `node:zlib` já traz a única parte difícil (inflate); o PDF precisava só da camada de texto (com CMaps ToUnicode e object streams) para citar página. Quatro dependências grandes a menos num bundle que tem de ficar abaixo de 100 MB, e nenhuma delas com módulo nativo.
Consequência: `documents/extract/` é nosso: ZIP, DOCX, XLSX, PPTX, PDF, EML (MIME, quoted-printable, anexos), HTML→Markdown e CSV, com testes sobre arquivos gerados no próprio teste. PDF sem camada de texto vira caso de OCR, que é o desenho da DOC-03.

## 2026-09-02 · OCR rasteriza pelas imagens embutidas do PDF antes de pedir um rasterizador
Por quê: PDF escaneado é quase sempre uma imagem por página (JPEG); extrair essas imagens não instala nada. Só quando não há imagem utilizável o Studio procura `mutool`/`pdftoppm` na máquina.
Consequência: `documents/extract/pdfimages.ts` grava JPEG como está e recodifica bitmaps em PNG com `node:zlib`. Nada de canvas nativo.

## 2026-09-02 · Busca vetorial funciona sem a extensão sqlite-vec
Por quê: exigir uma extensão nativa para responder à primeira pergunta contradiz "copiar a pasta = mover a instalação". A varredura por cosseno em JS dá conta de milhares de trechos.
Consequência: `core/db.ts` carrega `sqlite-vec` quando existe em `engines/sqlite-ext/` e cai para JS quando não. O catálogo traz a extensão como opcional (DOC-00).

## 2026-09-02 · MCP escrito à mão (JSON-RPC sobre POST), sem o SDK oficial
Por quê: o `@modelcontextprotocol/sdk` traria dependências e superfície que o Studio não usa; o Streamable HTTP que os clientes precisam é JSON-RPC simples.
Consequência: `api/routes/mcp.ts` implementa initialize/tools-list/tools-call/ping; erro de ferramenta vira conteúdo com o motivo (o agente lê), método inválido vira erro de protocolo. Testado no api.test.ts.

## 2026-09-02 · Contrato de áudio ganhou `words` no TranscriptSegment
Por quê: AUD-01 pede timestamps por palavra (whisper `-ojf`), e a UI de reunião usa isso para alinhar a fala.
Consequência: `audio/types.ts#TranscriptSegment.words?: TranscriptWord[]` — adição opcional, nada quebra.

## 2026-09-02 · dsh é instalado com pnpm (via `npx pnpm@11`), não com npm
Por quê: `npm install @deepseek-ai/dsh@0.1.1-rc.2` ficou >25 min a 3,6 GB de RAM resolvendo a árvore (60+ pacotes do workspace); pnpm resolveu em ~1 min. Nativos opcionais (node-pty, koffi) liberados por `pnpm.onlyBuiltDependencies` no `agent/package.json`.
Consequência: a primeira instalação do agente exige internet e ~1–3 min; o cache fica em `data/cache/npm`.

## 2026-09-02 · Motores adotados do ULS por hardlink antes de baixar
Por quê: a máquina do dono já tinha 3 GB de binários validados; hardlink é instantâneo e não duplica disco.
Consequência: `engines/<motor>/<os-arch>/<backend>/install.json` registra a origem (`uls:` ou `catalog:`); o catálogo continua sendo o caminho para máquinas limpas.

## 2026-09-02 · sd.cpp em modo CLI primeiro; whisper idem
Por quê: prova o caminho ponta a ponta (receitas, slots, saídas) sem gerir um servidor a mais; o custo é recarregar o checkpoint por imagem (ENG-05b resolve com sd-server).

## 2026-09-02 · Modelos gated ficam no plano com aviso, em vez de falhar
Por quê: a UI precisa mostrar o plano e pedir o token; esconder o plano inteiro confundia.
Consequência: `resolveFrom` tenta alternativas abertas primeiro (repacks Comfy-Org/city96), senão mantém o gated e avisa.

## 2026-09-02 · VAE do FLUX vem do repack aberto da Comfy-Org
Por quê: `black-forest-labs/FLUX.1-schnell` virou `gated: auto` em 2026; `Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors` é o mesmo arquivo (335 MB) sem gate.

## 2026-09-02 · Árvore do Hugging Face é paginada; caminhos exatos confirmam por HEAD
Por quê: repos como `rhasspy/piper-voices` passam de 1000 entradas. `HfClient.tree` segue `Link: rel="next"` (até 25 páginas) e `resolveFrom` cai para `fileMeta` (HEAD) quando o path não aparece.

## 2026-09-02 · Chunks paralelos existem, mas só quando ajudam (MOD-07)
Por quê: um fluxo satura a CDN do HF em links domésticos; abrir conexões à toa piora em rede fraca. Agora o downloader decide: arquivo acima de 64 MiB, servidor que aceita `Range` e `downloads.parallelChunks > 1`.
Consequência: `models/parallel.ts` grava cada faixa direto no `.part` pelo offset e registra as faixas prontas num `.part.json`, então retomar não rebaixa o que já caiu. Fora dessas condições, segue o fluxo único de sempre. Falta medir o ganho no link do dono para escolher o padrão (hoje 4).

## 2026-09-02 · `node:sqlite` em vez de better-sqlite3
Por quê: invariante "sem módulos nativos npm" (bundle único, portátil). Node 24 traz `node:sqlite` estável e `loadExtension` (sqlite-vec vai em `engines/sqlite-ext/`).

## 2026-09-02 · Hono como roteador
Por quê: minúsculo, TypeScript, sem dependências nativas, SSE embutido. Alternativa (Fastify) pesa mais no bundle.

## 2026-09-02 · dsh embutido, versão fixada, camada isolada em `server/src/agent/`
Por quê: o dsh é "developer preview" com quebras anunciadas. Fixar a versão e concentrar a integração num módulo limita o raio de explosão.

## 2026-09-02 · Receitas em YAML com `status` honesto
Por quê: adicionar modelo sem código; e o usuário vê o que foi testado (`verified`) vs. apontado (`draft`/`planned`).

## 2026-09-02 · Porta 1420 (herdada do ULS)
Por quê: o dono já conhece; cai para 1421–1499 se ocupada.
