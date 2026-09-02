# Publicação no GitHub — feito

O repositório está publicado em
**https://github.com/pantojinho/Portable-IA-Studio---DeepSeek-Harness** (público), branch `main`.

Pasta local: `D:\AI Studio\aistudio\Portable IA Studio` (o nome tem espaços; use aspas nos comandos).

## Dia a dia

```bash
cd "D:\AI Studio\aistudio\Portable IA Studio" && git push
```

A Action de CI roda a cada push: typecheck, testes, build e `doctor` em Windows, macOS e Linux.

## Privacidade do e-mail

Os commits têm autor `CIANDRINI <gabrielpantojinho@gmail.com>` e o repositório é público, então esse
endereço está visível. Para trocar pelo e-mail anônimo do GitHub daqui para frente:

```bash
cd "D:\AI Studio\aistudio\Portable IA Studio" && git config user.email "SEU-ID+SEU-USUARIO@users.noreply.github.com"
```

O histórico já enviado continua com o e-mail antigo. Reescrever exige `git filter-repo` e um
`git push --force`, o que quebra clones existentes; decida se compensa.

## Se quiser tornar privado

Em Settings → General → Danger Zone → Change repository visibility, no GitHub.

## Para quem vai contribuir

Leia `HANDOFF.md` (estado atual e armadilhas), `AGENTS.md` (regras) e pegue uma tarefa em
`docs/SPRINTS.md`. Branch por tarefa: `task/<ID>`.
