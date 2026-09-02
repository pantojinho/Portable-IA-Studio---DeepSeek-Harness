# Publicar no GitHub

O repositório local está pronto em `D:\AI Studio\aistudio` (branch `main`, commits feitos).
A publicação precisa da sua conta; são dois comandos.

## Opção A — GitHub CLI (recomendado)

```powershell
winget install GitHub.cli
gh auth login
cd "D:\AI Studio\aistudio"
gh repo create aistudio --private --source . --push
```

Troque `--private` por `--public` se quiser abrir. A Action de CI roda sozinha no primeiro push
(typecheck, testes, build, doctor em Windows/macOS/Linux).

## Opção B — pelo site

1. Crie um repositório vazio em https://github.com/new (sem README, sem .gitignore).
2. No terminal:

```powershell
cd "D:\AI Studio\aistudio"
git remote add origin https://github.com/<seu-usuario>/aistudio.git
git push -u origin main
```

## Depois de publicar

- Ative o Dependabot/Actions em Settings se quiser.
- Para o enxame: cada agente clona o repo, lê `AGENTS.md`, pega uma tarefa em `docs/SPRINTS.md` e abre PR na branch `task/<ID>`.
