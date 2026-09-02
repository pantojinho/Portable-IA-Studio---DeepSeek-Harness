# AI Studio

Estúdio de IA local e **portátil** (Windows · macOS · Linux): texto, imagem, vídeo, fala, música, OCR,
projetos de documentos com memória e busca, agente de código embutido (DeepSeek Harness) e APIs
OpenAI-compatíveis. Nada é instalado no sistema: copiar a pasta é mover a instalação.

Plano completo: [`../PLANO.md`](../PLANO.md).

## Usar (pacote pronto)

| Sistema | Abrir |
|---|---|
| Windows | duplo clique em `start.bat` |
| macOS | duplo clique em `start.command` (ou `./aistudio serve`) |
| Linux | `./start.sh` |

Na primeira execução o launcher baixa um Node.js portátil para `runtime/` (≈ 30–45 MB).
A interface abre em `http://127.0.0.1:1420`.

```
aistudio serve [--host 0.0.0.0] [--port N] [--no-open] [--api-key K] [--data-dir D]
aistudio doctor
```

## Desenvolver (a partir do código-fonte)

Requer Node 24+.

```bash
npm install
npm run build        # gera dist/server.cjs (um único arquivo)
npm run dev          # build + serve sem abrir o navegador
npm run doctor
npm test
```

## Layout

```
aistudio/
├── aistudio(.cmd)  start.*     launchers
├── server/src/                 código do servidor (TypeScript → dist/server.cjs)
├── web/                        interface (React + Vite → web/dist)
├── models/recipes/             receitas de modelos
├── runtime/ engines/ models/   baixados sob demanda (fora do git)
├── projects/ voices/ data/     estado do usuário (fora do git)
└── agent/                      DSH_HOME do agente
```

Licença MIT.
