# Passagem de bastão — Portable IA Studio

Documento para outra IA (ou pessoa) continuar o trabalho. Estado de 2026-09-02.

---

## 1. Onde está

| | |
|---|---|
| Pasta local | `D:\AI Studio\aistudio\Portable IA Studio` (o nome tem espaços: use aspas nos comandos) |
| GitHub | https://github.com/pantojinho/Portable-IA-Studio---DeepSeek-Harness — **público, já publicado** |
| Branch | `main`, 11 commits enviados |
| Licença | MIT |
| Testes | 24 testes unitários (`npm test`) verdes; `npm run typecheck` limpo |
| CI | `.github/workflows/ci.yml`: typecheck, testes, build e `doctor` em Windows, macOS e Linux |

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

Nasceu de dois projetos: `techjarves/Uncensored-Local-Studio` (motores e interface que já funcionavam na
máquina do dono) e `deepseek-ai/deepseek-harness` (o agente, que é **embutido**, nunca reescrito).

Plano completo em `PLANO.md`. Arquitetura em `docs/ARCHITECTURE.md`. Regras em `AGENTS.md`.

---

## 3. O que já funciona (testado na máquina do dono, RTX A1000 6 GB)

| Recurso | Como foi verificado |
|---|---|
| Portabilidade | `start.bat` baixou o Node 24.19 portátil (101 MB) e rodou sem o Node do sistema |
| Clone limpo | clonado numa pasta vazia: instalou dependências, construiu e serviu a interface sozinho |
| Modelos por link | os 10 links do dono resolvem para os arquivos certos; 21 receitas prontas |
| Download seguro | rejeita HTML, confere sha256, retoma por Range, classifica pelo conteúdo |
| Migração | `models migrate` achou os 4 arquivos HTML falsos e os 2 downloads incompletos do projeto antigo |
| Motores | adotados do projeto antigo por hardlink: llama.cpp (cuda/vulkan/cpu), sd.cpp (cuda/vulkan/cpu), whisper (cpu) |
| Chat local | `/v1/chat/completions` com stream, Qwen3.5-4B |
| Imagens | `/v1/images/generations`, SD1.5 512×512 em 10,6 s, com galeria |
| Transcrição | `/v1/audio/transcriptions` com whisper (só WAV 16 kHz por enquanto) |
| APIs remotas | `provedor:modelo` para openai, anthropic, deepseek, openrouter, groq, ollama |
| Interface | `web/dist/index.html`: Chat, Imagens, Modelos, Motores & APIs, Agente, Trabalhos |
| Agente | `aistudio agent install` e `start` sobem o `dsh web` em cerca de 10 s; o dsh enxerga o provedor "local" |

Comandos:

```
aistudio serve | doctor
aistudio models list | resolve <link> | pull <link> | inspect <arq> | recipes | migrate [--import] | token hf <TOKEN>
aistudio engines list | adopt | install <motor> | start <modelo>
aistudio providers list | key <id> <CHAVE>
aistudio run "pergunta" [--model id]
aistudio agent install | start | run "tarefa"
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
8. **A pasta tem espaços no nome.** Todo comando precisa de aspas: `cd "D:\AI Studio\aistudio\Portable IA Studio"`.

---

## 5. O que fazer agora

Leia `AGENTS.md` (invariantes e protocolo de trabalho em paralelo) e pegue tarefas em `docs/SPRINTS.md`,
que traz cada tarefa com dependências, arquivos a tocar, código a reaproveitar e critério de aceite.

Prioridades declaradas pelo dono, nesta ordem:

1. **S3 · Áudio.** Mais motores de voz (Piper, Kokoro, OuteTTS), clonagem de voz, música, e gravação de
   reuniões com transcrição, identificação de quem fala e resumo.
2. **S4 · Documentos.** Projetos com fontes, OCR com GLM-OCR, índice SQLite híbrido, memória, perguntas com
   citações, extração e validação de notas fiscais, cruzamento com planilha.

Depois: interface em React (S5), vídeo, serviço fixo e empacotamento de release (S6).

Invariantes que não podem ser quebrados (detalhe em `AGENTS.md`): tudo relativo à pasta raiz; núcleo abaixo
de 100 MB; um único arquivo de servidor sem módulos nativos npm; nada entra na biblioteca sem inspeção de
bytes; o Studio nunca apaga dados do usuário; a rede fica fechada em 127.0.0.1 por padrão; trabalho longo
vira job com progresso; receitas de modelos são dados YAML, não código.

### Fluxo para cada tarefa

1. Marque a tarefa como `doing` em `docs/SPRINTS.md` com seu nome e a data.
2. Trabalhe numa branch `task/<ID>`.
3. `npm run typecheck`, `npm test` e `npm run build` verdes antes de abrir PR.
4. Atualize `docs/API.md` se mexeu em endpoints, e o status da tarefa em `docs/SPRINTS.md`.
