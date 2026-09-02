# Passagem de bastão — Portable IA Studio

Documento para outra IA (ou pessoa) continuar o trabalho. Estado de 2026-09-02, segunda rodada.

---

## 1. Onde está

| | |
|---|---|
| Pasta local | `D:\AI Studio\aistudio\Portable IA Studio` (o nome tem espaços: use aspas nos comandos) |
| GitHub | https://github.com/pantojinho/Portable-IA-Studio---DeepSeek-Harness — **público** |
| Branch de trabalho | `claude/projeto-continuacao-3r4cjw` (PR #1, rascunho) sobre `main` |
| Licença | MIT |
| Testes | 109 unitários/integração verdes + 2 pulados (ao vivo); `npm run typecheck` limpo |
| CI | `.github/workflows/ci.yml`: typecheck, testes, build, `doctor`, `test:api` em Windows/macOS/Linux + job que gera os pacotes portáteis |

Ao lado, como referência (não mexer): `D:\AI Studio\Uncensored-Local-Studio-main`.

### Aviso de privacidade

O repositório é **público** e os commits têm autor `CIANDRINI <gabrielpantojinho@gmail.com>`.
Esse e-mail está visível para qualquer pessoa. Para esconder: ativar o e-mail privado nas configurações do
GitHub, trocar o `user.email` local pelo endereço `@users.noreply.github.com` e reescrever o histórico com
`git filter-repo` ou `git rebase`, seguido de `git push --force`. O dono precisa decidir se vale a pena.

---

## 2. O que o projeto é

Estúdio de IA local e portátil (Windows, macOS, Linux) que roda modelos de texto, imagem, vídeo, fala,
música e OCR, com projetos de documentos (OCR e busca), agente de código embutido e APIs OpenAI.
Nada é instalado no sistema: copiar a pasta move a instalação inteira.

Plano completo em `PLANO.md`. Arquitetura em `docs/ARCHITECTURE.md`. Regras em `AGENTS.md`.
Guia do usuário em `docs/USO.md`. Backlog e estado por tarefa em `docs/SPRINTS.md`.

---

## 3. O que existe hoje

**Testado na máquina do dono (RTX A1000 6 GB), primeira rodada:** portabilidade, clone limpo, resolução
dos 10 links, download seguro, migração da instalação antiga, adoção dos motores do ULS, chat local com
stream, imagem SD1.5 em 10,6 s, transcrição WAV, provedores remotos, agente `dsh web` subindo em ~10 s.

**Escrito e coberto por testes nesta rodada** (sem GPU e sem pesos grandes aqui — ver seção 5):

| Área | O que entrou |
|---|---|
| Fundação | `data/jobs.sqlite` com histórico e recuperação de trabalhos interrompidos; `PUT /api/v1/config` validado com aplicação a quente; várias chaves de API com rate-limit e recusa de `--host` público sem chave |
| Áudio | ffmpeg como motor (converte, lista dispositivos, grava mic + som do sistema); whisper completo (qualquer formato, palavras, falantes com `-tdrz`, tradução); vozes Piper/Kokoro por sherpa-onnx, OuteTTS por `llama-tts`, clonagem em venv Python; música; reuniões com transcrição ao vivo e resumo |
| Documentos | projetos portáteis com `index.sqlite`; ingestão de PDF, Word, Excel, PowerPoint, e-mail, HTML, CSV, imagem e áudio; OCR pelo modelo de visão; busca híbrida (FTS5 + vetores com RRF); perguntas com citações; memória; tipos de documento em YAML com validadores brasileiros; cruzamento com planilha; conectores de pasta e IMAP |
| Motores | VRAM do sd.cpp no planejador; `/v1/images/edits`, upscale e LoRA; vídeo (`vid_gen` → mp4); configurações por modelo |
| Agente | `/mcp` com 16 ferramentas, já registrado no `settings.yaml` do dsh |
| Operação | `aistudio service install` nos 3 SO; `packaging/build-release.mjs` (núcleo com 0,9 MB); `docs/USO.md`; suíte de contratos `npm run test:api` |
| Interface | Projetos, Áudio, Reuniões, Vídeo e Configurações somadas às telas antigas — testadas num Chromium de verdade |

Comandos:

```
aistudio serve | doctor
aistudio models    list | resolve <link> | pull <link> | inspect <arq> | recipes | migrate [--import] | token hf <TOKEN>
aistudio engines   list | adopt | install <motor> | start <modelo>
aistudio providers list | key <id> <CHAVE>
aistudio run "pergunta" [--model id]
aistudio agent     install | start | run "tarefa"
aistudio projects  list | new "Nome" | add <proj> <arquivos> | ingest | search | ask | extract | crosscheck | report | ocr
aistudio speak "texto" [--voice id] [--out arquivo]
aistudio transcribe <arquivo> [--diarize] [--format srt|vtt|json]
aistudio meeting   devices | start [--title T] [--project P] | stop | export
aistudio config    show | set <chave> <valor> | keys new|list|remove
aistudio service   install | uninstall | status | start | stop | logs
```

Para rodar: duplo clique em `start.bat` (Windows), `start.command` (macOS) ou `./start.sh` (Linux).
A interface abre em `http://127.0.0.1:1420`.

---

## 4. Armadilhas já descobertas (não repita)

1. **`npm install @deepseek-ai/dsh` trava.** Passou de 25 minutos consumindo 3,6 GB de RAM sem terminar.
   Use `pnpm` (`npx pnpm@11 add`), que resolve em cerca de 1 minuto. Já está assim no código.
2. **Launchers `.cmd` e `.bat` precisam de CRLF.** Com LF, o `cmd.exe` interpreta cada palavra como comando.
   O `.gitattributes` força `eol=crlf` nesses arquivos; não mexa nisso.
3. **A árvore do Hugging Face é paginada** em 1000 entradas (cabeçalho `Link: rel="next"`). Repositórios
   grandes como `rhasspy/piper-voices` passam disso.
4. **Arquivos pequenos (não LFS) não trazem `X-Linked-Size`.** Para saber o tamanho é preciso `HEAD` seguindo
   o redirecionamento e com `accept-encoding: identity`, senão o download falha por "tamanho incompleto".
5. **`black-forest-labs/FLUX.1-schnell` virou gated em 2026.** O VAE do FLUX vem do repack aberto da
   Comfy-Org (`Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors`, arquivo idêntico).
6. **A causa do bug de download do projeto original** está em `serve.cjs:5145`: ele grava no disco qualquer
   coisa que o servidor devolva, sem checar o conteúdo. Por isso páginas HTML viravam "modelos".
7. **`dist/` no `.gitignore` também casa com `web/dist/`.** Isso já derrubou a interface do repositório uma vez.
   Pelo mesmo motivo, `engines/*` escondia `engines/python/` — hoje há um `!engines/python/**`.
8. **A pasta tem espaços no nome.** Todo comando precisa de aspas: `cd "D:\AI Studio\aistudio\Portable IA Studio"`.
9. **Um `.part` de download paralelo tem o tamanho final e buracos.** Quem manda é o `.part.json`;
   nunca trate "tamanho igual ao esperado" como "download completo".
10. **whisper.cpp só publica binário para Windows.** No macOS e no Linux, adote do ULS (`engines adopt`) ou compile.
11. **A UI é um arquivo só e sem build.** Um `let` usado antes da declaração derruba o script inteiro
    (aconteceu com os ouvintes de SSE). Rode a interface num navegador antes de dizer que funciona.
12. **`node:sqlite` avisa "experimental" no Node 22.** No Node 24 (o runtime portátil) não avisa;
    o aviso de módulo embutido não passa pelo evento `warning`, então não dá para filtrar.

---

## 5. O que falta (e por que não dá para fechar daqui)

Esta rodada rodou num contêiner Linux **sem GPU, sem os pesos e sem acesso ao github.com**. Então:

1. **MOD-09 · promover receitas.** Cada receita nova nasceu `draft`. Rodar de ponta a ponta na A1000 e
   marcar `verified`: `piper-pt-br-faber`, `piper-pt-br-edresson`, `kokoro-82m`, `whisper-small-tdrz`,
   `esrgan-4x`, `wan2.2-ti2v-5b`.
2. **ENG-01b · catálogo em máquina limpa.** As versões de whisper.cpp (v1.7.4), sherpa-onnx (v1.10.28),
   sqlite-vec (v0.1.6) e uv estão fixadas mas **não foram baixadas daqui**. Rode
   `aistudio engines install sherpa-onnx` (e os outros) numa máquina sem o ULS; se a URL mudou, o erro
   mostra qual foi tentada — corrija a release no `engines/catalog.yaml` e preencha os hashes.
3. **ENG-05b · `sd-server` persistente.** O modo CLI recarrega o checkpoint a cada imagem. Falta o
   servidor persistente (o resto da tarefa — edits, upscale, LoRA — está pronto).
4. **MOD-07 · medir.** O download paralelo existe e tem teste, mas o padrão (4 pedaços acima de 64 MiB)
   precisa de uma medição no link do dono para virar recomendação.
5. **S5 · React.** Todas as telas existem na UI sem build. A migração traria componentização, i18n,
   PWA e a tela "Treinar"; as chamadas de API não mudam.
6. **S7 inteira** (persona, avatar, treino de LoRA, colibri, NPU, Tauri) segue no backlog.
7. **Reuniões no Windows/macOS.** A captura do som do sistema depende de um dispositivo de loopback
   (virtual-audio-capturer / BlackHole). A detecção está escrita; falta confirmar em cada SO.

### Como conferir rápido na máquina do dono

```
aistudio doctor                    # a seção "Recursos" diz o que falta para cada função
aistudio models pull recipe:piper-pt-br-faber
aistudio speak "bom dia, isso é um teste" --out teste.wav
aistudio models pull recipe:whisper-large-v3-turbo
aistudio transcribe teste.wav --format json
aistudio projects new "Notas 2026" && aistudio projects add notas-2026 "C:\caminho\notas" && aistudio projects ingest notas-2026
aistudio projects ask notas-2026 "quais notas vencem este mês?"
```

---

## 6. Fluxo para cada tarefa

1. Marque a tarefa como `doing` em `docs/SPRINTS.md` com seu nome e a data.
2. Trabalhe numa branch `task/<ID>`.
3. `npm run typecheck`, `npm test` e `npm run build` verdes antes de abrir PR.
4. Atualize `docs/API.md` se mexeu em endpoints, e o status da tarefa em `docs/SPRINTS.md`.
5. Se mudou um contrato (`server/src/*/types.ts`), registre em `docs/DECISIONS.md`.
