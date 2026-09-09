# Leitor OMR - Node.js

Protótipo para ler o cartão-resposta de 35 questões (A-E).

## Requisitos
- Node.js 20 ou superior.

## Instalação
```bash
npm install
npm start
```

Abra:
http://localhost:3000

## Estrutura
- `index.js`: servidor Node/Express + PDF + processamento OMR.
- `public/index.html`: interface web.
- `public/styles.css`: estilos.
- `package.json`: dependências.

## Formatos
- PDF com uma ou várias páginas
- PNG
- JPG/JPEG

## Como funciona
1. Localiza os quatro quadrados pretos da folha.
2. Usa esses marcadores para mapear a posição das 175 bolinhas.
3. Mede a quantidade de pixels escuros dentro de cada bolinha.
4. Classifica cada questão como:
   - marcada
   - em branco
   - dupla
5. Se você informar um gabarito de 35 letras, calcula acertos e nota de 0 a 10.

## Calibração
No topo do `index.js`, ajuste:
- `MARK_THRESHOLD`
- `FILL_THRESHOLD`
- `MAYBE_THRESHOLD`
- `SAMPLE_RADIUS_BASE`

O painel "Ver diagnóstico das bolinhas" mostra a porcentagem escura de A-E por questão e ajuda a calibrar.
