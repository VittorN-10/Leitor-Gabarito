const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const DATA_DIR = path.join(__dirname, "..", "data");
const ALUNOS_FILE = path.join(DATA_DIR, "alunos.json");
const AVALIACOES_FILE = path.join(DATA_DIR, "avaliacoes.json");

function lerJson(caminho, padrao) {
  if (!fs.existsSync(caminho)) return padrao;

  try {
    return JSON.parse(fs.readFileSync(caminho, "utf8"));
  } catch (error) {
    console.error(`Erro ao ler ${caminho}:`, error);
    throw new Error("Não foi possível ler os dados armazenados.");
  }
}

function carregarAlunos() {
  return lerJson(ALUNOS_FILE, []);
}

function carregarAvaliacoes() {
  return lerJson(AVALIACOES_FILE, []);
}

function salvarAvaliacoes(avaliacoes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const temporario = `${AVALIACOES_FILE}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(avaliacoes, null, 2), "utf8");
  fs.renameSync(temporario, AVALIACOES_FILE);
}

function normalizarTurma(valor) {
  return String(valor || "").normalize("NFC").trim();
}

function gerarId(avaliacoes) {
  const ano = new Date().getFullYear();
  const prefixo = `AV-${ano}-`;

  const numeros = avaliacoes
    .filter(item => item.id && item.id.startsWith(prefixo))
    .map(item => Number(item.id.slice(prefixo.length)))
    .filter(Number.isInteger);

  return `${prefixo}${String(Math.max(0, ...numeros) + 1).padStart(4, "0")}`;
}

router.get("/turmas", (_req, res) => {
  try {
    const alunos = carregarAlunos();
    const turmas = [...new Set(
      alunos.map(aluno => normalizarTurma(aluno.turma)).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, "pt-BR"));

    res.json({ ok: true, total: turmas.length, turmas });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/", (_req, res) => {
  try {
    const avaliacoes = carregarAvaliacoes()
      .sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));

    res.json({ ok: true, total: avaliacoes.length, avaliacoes });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/:id", (req, res) => {
  try {
    const avaliacao = carregarAvaliacoes().find(item => item.id === req.params.id);

    if (!avaliacao) {
      return res.status(404).json({ ok: false, error: "Avaliação não encontrada." });
    }

    res.json({ ok: true, avaliacao });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/", (req, res) => {
  try {
    const titulo = String(req.body.titulo || "").trim();
    const turma = normalizarTurma(req.body.turma);
    const quantidadeQuestoes = Number(req.body.quantidadeQuestoes);

    if (!titulo) {
      return res.status(400).json({ ok: false, error: "Informe o nome da avaliação." });
    }

    if (titulo.length > 100) {
      return res.status(400).json({ ok: false, error: "O nome deve ter no máximo 100 caracteres." });
    }

    if (!turma) {
      return res.status(400).json({ ok: false, error: "Selecione uma turma." });
    }

    if (!Number.isInteger(quantidadeQuestoes) || quantidadeQuestoes < 1 || quantidadeQuestoes > 35) {
      return res.status(400).json({
        ok: false,
        error: "A quantidade de questões deve ser um número inteiro entre 1 e 35."
      });
    }

    const alunos = carregarAlunos();
    const turmaEncontrada = alunos.some(
      aluno => normalizarTurma(aluno.turma) === turma
    );

    if (!turmaEncontrada) {
      return res.status(400).json({
        ok: false,
        error: "A turma selecionada não foi encontrada no cadastro de alunos."
      });
    }

    const avaliacoes = carregarAvaliacoes();
    const novaAvaliacao = {
      id: gerarId(avaliacoes),
      titulo,
      turma,
      quantidadeQuestoes,
      gabarito: null,
      status: "rascunho",
      criadaEm: new Date().toISOString()
    };

    avaliacoes.push(novaAvaliacao);
    salvarAvaliacoes(avaliacoes);

    res.status(201).json({
      ok: true,
      mensagem: "Avaliação criada com sucesso.",
      avaliacao: novaAvaliacao
    });
  } catch (error) {
    console.error("Erro ao criar avaliação:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Erro ao criar avaliação."
    });
  }
});

module.exports = router;
