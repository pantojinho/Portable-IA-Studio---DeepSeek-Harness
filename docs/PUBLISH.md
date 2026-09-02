# Publicar no GitHub

O repositório local está pronto em `D:\AI Studio\aistudio`: branch `main`, 10 commits, nada pendente.
Um clone limpo já roda sozinho (baixa o Node portátil, instala dependências, constrói e abre a interface).

A publicação precisa da **sua** conta: esta máquina não tem `gh`, token, chave SSH nem credencial do
GitHub salva, então ninguém consegue autenticar por você.

## Opção A — sem instalar nada (mais rápida)

1. Crie um repositório vazio em https://github.com/new — **sem** README, **sem** .gitignore, **sem** licença.
2. No terminal:

```bash
cd "D:\AI Studio\aistudio" && git remote add origin https://github.com/SEU-USUARIO/aistudio.git && git push -u origin main
```

O Git Credential Manager (já configurado nesta máquina) abre o navegador para você entrar no GitHub
uma única vez. Depois disso, `git push` funciona sem perguntar nada.

## Opção B — GitHub CLI (cria o repositório e envia num comando)

```bash
winget install GitHub.cli
```
```bash
gh auth login
```
```bash
cd "D:\AI Studio\aistudio" && gh repo create aistudio --private --source . --push
```

Troque `--private` por `--public` se quiser abrir o projeto.

## Antes de escolher público ou privado

- Os commits carregam o autor `CIANDRINI <gabrielpantojinho@gmail.com>`. Num repositório **público**, esse
  e-mail fica visível. Para esconder, ative o e-mail privado do GitHub e reescreva o autor antes do push.
- Nenhum segredo está versionado: `data/`, `models/`, `engines/` (exceto o catálogo), `projects/`,
  `voices/`, `runtime/` e `agent/node_modules` ficam fora do git.
- O `LICENSE` diz "AI Studio contributors". Troque pelo seu nome se quiser assinar.

## Depois de publicar

A Action de CI roda no primeiro push (typecheck, testes, build e `doctor` em Windows, macOS e Linux).

Para o enxame: cada agente clona o repositório, lê `AGENTS.md`, pega uma tarefa `todo` em
`docs/SPRINTS.md` e abre PR na branch `task/<ID>`.
