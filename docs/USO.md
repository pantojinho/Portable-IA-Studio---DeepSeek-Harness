# Guia de uso — AI Studio

Escrito para quem vai **usar**, não para quem programa. Se algo aqui não funcionar como está escrito,
é bug: abra uma issue com o que apareceu na tela.

---

## 1. Instalar (2 minutos)

1. Baixe o `.zip` do seu sistema e descompacte onde quiser — pendrive, HD externo, `D:\`, qualquer lugar.
2. Abra a pasta e rode:
   - **Windows:** duplo clique em `start.bat`
   - **macOS:** duplo clique em `start.command` (na primeira vez: botão direito → Abrir)
   - **Linux:** `./start.sh`
3. A primeira execução baixa o Node portátil (~100 MB) e constrói o servidor. Da segunda em diante abre em segundos.
4. A interface abre sozinha em <http://127.0.0.1:1420>.

Nada é instalado no sistema. **Copiar a pasta é mover a instalação inteira**, com modelos e projetos.

---

## 2. Primeiros passos

| Quero… | Faça |
|---|---|
| Conversar com uma IA local | Aba **Chat** → escolha o modelo (baixe um antes na aba Modelos) |
| Baixar um modelo | Aba **Modelos** → cole o link do Hugging Face → veja o plano → **Baixar** |
| Aproveitar modelos que já tenho | Aba **Modelos** → **Migrar instalação antiga** |
| Gerar imagens | Aba **Imagens** |
| Falar um texto | Aba **Áudio → Vozes** |
| Transcrever uma reunião | Aba **Reuniões** |
| Perguntar aos meus documentos | Aba **Projetos** |

Pelo terminal, dentro da pasta:

```
aistudio doctor                      # o que a máquina tem e o que falta
aistudio models pull recipe:qwen3-4b # baixar um modelo de texto
aistudio run "resuma o que é NF-e"   # conversar rapidinho
aistudio projects new "Notas 2026"   # criar um projeto de documentos
```

No Windows use `aistudio.cmd`; no macOS e no Linux, `./aistudio`.

---

## 3. Escolher o modelo certo para a sua placa

O Studio olha a sua VRAM e sugere a quantização que cabe. Regra de bolso:

| VRAM | Texto | Imagem |
|---|---|---|
| 4 GB | modelos 3–4B em Q4_K_M | SD 1.5, SDXL com `--offload-to-cpu` |
| 6 GB (ex.: RTX A1000) | 4–8B em Q4_K_M | SDXL, Flux klein com offload |
| 8–12 GB | 8–14B em Q4/Q5 | SDXL, Flux, vídeo curto |
| 16 GB+ | 14–32B | quase tudo |

Sem placa de vídeo tudo continua funcionando na CPU — mais devagar, mas funciona.

---

## 4. Documentos, notas fiscais e OCR

1. **Projetos → Novo**, dê um nome.
2. Arraste os arquivos (PDF, Word, Excel, PowerPoint, e-mail, imagem, áudio).
3. O Studio lê cada um: PDF com texto é lido direto; PDF escaneado vai para o OCR; áudio é transcrito.
4. **Perguntar** responde com as citações — clique na citação para ver o trecho no documento.
5. **Extrair campos** classifica cada documento (NF-e, NFS-e, boleto, contrato…) e confere:
   - chave de acesso de 44 dígitos (dígito verificador mod 11);
   - CNPJ e CPF;
   - soma dos itens contra o total;
   - datas (vencimento antes da emissão, data no futuro).
6. **Cruzar com planilha** compara o que foi extraído com um CSV/XLSX do seu sistema e lista as divergências.

Para OCR você precisa de um modelo de visão: `aistudio models pull recipe:glm-ocr`.

---

## 5. Áudio

- **Falar:** baixe uma voz (`aistudio models pull recipe:piper-pt-br-faber`) e use a aba Vozes ou
  `aistudio speak "bom dia" --out ola.wav`.
- **Transcrever:** `aistudio transcribe reuniao.mp4 --diarize --format srt --out reuniao.srt`.
- **Reuniões:** aba Reuniões → escolha microfone e/ou som do sistema → Gravar. Ao parar, o Studio
  transcreve, separa os falantes e escreve um resumo com decisões e ações.
  - Windows: para gravar o som do sistema é preciso um dispositivo de loopback (ex.: *virtual-audio-capturer* ou VB-Cable).
  - macOS: instale o BlackHole.
  - Linux: escolha a fonte que termina em `.monitor`.

---

## 6. Rodar sozinho ao ligar o computador

```
aistudio service install     # Windows: tarefa no logon · macOS: LaunchAgent · Linux: systemd --user
aistudio service status
aistudio service logs
aistudio service uninstall
```

No Linux, para o serviço subir sem você fazer login: `sudo loginctl enable-linger $USER`.

---

## 7. Usar de outro computador da rede

Por padrão o Studio só aceita conexões da própria máquina. Para abrir para a rede:

```
aistudio config keys new           # crie uma chave (aparece uma única vez)
aistudio serve --host 0.0.0.0 --api-key <sua-chave>
```

Sem chave, servir em outro endereço é recusado. Em qualquer cliente compatível com OpenAI aponte
para `http://<ip-da-máquina>:1420/v1` e use a chave como `Authorization: Bearer`.

---

## 8. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "Porta 1420 ocupada" | O Studio já sobe na 1421+. Se insistir: `aistudio serve --port 1500` |
| O antivírus reclama do motor | Os binários vêm de releases oficiais (llama.cpp, sd.cpp, whisper.cpp). Libere a pasta `engines/` |
| "modelo não encontrado na biblioteca" | `aistudio models list` mostra o que existe; baixe com `models pull` |
| Download virou um arquivo HTML | Não acontece mais: o Studio confere os bytes e recusa páginas de erro. Rode `aistudio models migrate` para marcar os arquivos falsos de instalações antigas |
| Geração de imagem sem memória | Reduza a resolução, use quantização menor ou deixe o offload agir (o Studio já liga acima de 4 GB de pesos) |
| Whisper reclama do formato | Instale o ffmpeg: `aistudio engines install ffmpeg` |
| OCR diz que falta o mmproj | Baixe a receita inteira: `aistudio models pull recipe:glm-ocr` |
| A GPU não é usada | `aistudio doctor` mostra o backend detectado; force com `aistudio config set engines.preferredBackend vulkan` |

Registros ficam em `data/logs/`. O arquivo `data/config.yaml` pode ser editado à mão.

---

## 9. Privacidade

Tudo roda na sua máquina. Nada é enviado para fora, exceto:

- downloads de modelos e motores que **você** pediu (Hugging Face, CivitAI, GitHub);
- chamadas a provedores de nuvem que **você** configurou com chave (`aistudio providers key …`).

O agente de código (dsh) só executa comandos com a sua aprovação, e o Studio nunca apaga nada fora
da própria biblioteca — apagar um projeto move a pasta para `data/trash/`.
