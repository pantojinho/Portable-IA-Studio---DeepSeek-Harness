# Decisões de arquitetura (ADR curto)

Formato: data · decisão · por quê · consequências. Adicione no topo. Mudar um contrato em
`server/src/*/types.ts` exige uma entrada aqui.

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

## 2026-09-02 · Download em um fluxo, com resume; chunks paralelos ficam para MOD-07
Por quê: um fluxo satura a CDN do HF em links domésticos e mantém o resume trivial. Paralelo só se medição mostrar ganho.

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
