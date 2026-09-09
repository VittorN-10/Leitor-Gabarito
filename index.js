const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const { createCanvas, DOMMatrix, DOMPoint, ImageData, Path2D } = require("@napi-rs/canvas");

// PDF.js 5.x usa DOMMatrix durante o carregamento do módulo.
// No Node.js/Windows esse objeto não existe globalmente por padrão.
// @napi-rs/canvas fornece a implementação necessária para o renderizador.
if (!globalThis.DOMMatrix && DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.DOMPoint && DOMPoint) globalThis.DOMPoint = DOMPoint;
if (!globalThis.ImageData && ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D && Path2D) globalThis.Path2D = Path2D;

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 }
});

/*
  Coordenadas de referência obtidas do cartão que estamos usando.
  A leitura final NÃO depende do papel estar exatamente nessa posição:
  primeiro localizamos os quatro quadrados pretos e depois mapeamos as
  bolinhas proporcionalmente entre eles.

  Sistema de referência usado na calibração:
    imagem = 893 x 1263
    marcador TL = (119, 212)
    marcador TR = (812, 214)
    marcador BL = (114, 1118)
    marcador BR = (807, 1120)
*/

const BASE = {
  width: 893,
  height: 1263,
  markers: {
    tl: { x: 119, y: 212 },
    tr: { x: 812, y: 214 },
    bl: { x: 114, y: 1118 },
    br: { x: 807, y: 1120 }
  }
};

const ALTERNATIVES = ["A", "B", "C", "D", "E"];

// Centros das bolinhas na folha de referência.
const GROUPS = [
  {
    start: 1,
    rows: 12,
    xs: [149, 185, 221, 256, 292],
    ys: [327, 364, 400, 437, 474, 511, 549, 586, 623, 660, 697, 734]
  },
  {
    start: 13,
    rows: 12,
    xs: [389, 425, 461, 497, 533],
    ys: [328, 365, 402, 439, 476, 513, 550, 587, 624, 661, 698, 735]
  },
  {
    start: 25,
    rows: 11,
    xs: [630, 666, 702, 738, 774],
    ys: [328, 365, 402, 439, 476, 513, 550, 587, 624, 661, 698]
  }
];

const QUESTION_POINTS = [];
for (const group of GROUPS) {
  for (let r = 0; r < group.rows; r++) {
    QUESTION_POINTS.push({
      question: group.start + r,
      choices: group.xs.map((x, i) => ({
        alternative: ALTERNATIVES[i],
        x,
        y: group.ys[r]
      }))
    });
  }
}

/*
  Ajustes principais do leitor.

  MARK_THRESHOLD:
    pixel abaixo disso é considerado "escuro".

  FILL_THRESHOLD:
    porcentagem mínima de pixels escuros no miolo da bolinha
    para considerar marcada.

  DOUBLE_MARGIN:
    se duas alternativas ultrapassarem o limiar, marcamos como DUPLA.

  Essas constantes foram deixadas no topo justamente para facilitar
  a calibração com novos scans.
*/
const CONFIG = {
  MARK_THRESHOLD: 125,
  FILL_THRESHOLD: 0.34,
  MAYBE_THRESHOLD: 0.22,
  SAMPLE_RADIUS_BASE: 7.2,
  MARKER_THRESHOLD: 105
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function baseToUV(x, y) {
  const leftTop = BASE.markers.tl;
  const rightTop = BASE.markers.tr;
  const leftBottom = BASE.markers.bl;

  const u = (x - leftTop.x) / (rightTop.x - leftTop.x);
  const v = (y - leftTop.y) / (leftBottom.y - leftTop.y);
  return { u, v };
}

function mapUVToPage(u, v, markers) {
  // Interpolação bilinear dos quatro marcadores.
  const topX = markers.tl.x + u * (markers.tr.x - markers.tl.x);
  const topY = markers.tl.y + u * (markers.tr.y - markers.tl.y);
  const bottomX = markers.bl.x + u * (markers.br.x - markers.bl.x);
  const bottomY = markers.bl.y + u * (markers.br.y - markers.bl.y);

  return {
    x: topX + v * (bottomX - topX),
    y: topY + v * (bottomY - topY)
  };
}

async function renderPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: false
  });

  const pdf = await task.promise;
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Escala 1.55 costuma produzir resolução suficiente sem consumir memória demais.
    const viewport = page.getViewport({ scale: 1.55 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport
    }).promise;

    pages.push(canvas.toBuffer("image/png"));
  }

  return pages;
}

async function fileToImages(file) {
  const mime = file.mimetype || "";
  const name = (file.originalname || "").toLowerCase();

  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    return await renderPdf(file.buffer);
  }

  if (mime.startsWith("image/")) {
    return [file.buffer];
  }

  throw new Error("Formato não suportado. Envie PDF, PNG ou JPG.");
}

async function grayscaleRaw(buffer) {
  const image = sharp(buffer).rotate().grayscale();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels
  };
}

function getPixel(gray, x, y) {
  x = Math.round(x);
  y = Math.round(y);

  if (x < 0 || y < 0 || x >= gray.width || y >= gray.height) {
    return 255;
  }

  return gray.data[y * gray.width + x];
}

function connectedComponentsInZone(gray, zone) {
  const x0 = clamp(Math.floor(zone.x0 * gray.width), 0, gray.width - 1);
  const x1 = clamp(Math.ceil(zone.x1 * gray.width), 0, gray.width - 1);
  const y0 = clamp(Math.floor(zone.y0 * gray.height), 0, gray.height - 1);
  const y1 = clamp(Math.ceil(zone.y1 * gray.height), 0, gray.height - 1);

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const visited = new Uint8Array(w * h);
  const components = [];

  const isDark = (gx, gy) =>
    getPixel(gray, gx, gy) < CONFIG.MARKER_THRESHOLD;

  const dirs = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1]
  ];

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const idx = ly * w + lx;
      if (visited[idx]) continue;

      const gx = x0 + lx;
      const gy = y0 + ly;

      if (!isDark(gx, gy)) {
        visited[idx] = 1;
        continue;
      }

      const queueX = [lx];
      const queueY = [ly];
      visited[idx] = 1;

      let q = 0;
      let count = 0;
      let minX = lx, maxX = lx, minY = ly, maxY = ly;
      let sumX = 0, sumY = 0;

      while (q < queueX.length) {
        const cx = queueX[q];
        const cy = queueY[q];
        q++;

        count++;
        sumX += cx;
        sumY += cy;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;

          const nidx = ny * w + nx;
          if (visited[nidx]) continue;

          const ngx = x0 + nx;
          const ngy = y0 + ny;

          if (isDark(ngx, ngy)) {
            visited[nidx] = 1;
            queueX.push(nx);
            queueY.push(ny);
          } else {
            visited[nidx] = 1;
          }
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const fill = count / (bw * bh);

      components.push({
        count,
        bw,
        bh,
        fill,
        x: x0 + sumX / count,
        y: y0 + sumY / count
      });
    }
  }

  return components;
}

function chooseMarker(gray, zone, expectedNorm) {
  const comps = connectedComponentsInZone(gray, zone);

  const candidates = comps
    .filter(c =>
      c.count >= 20 &&
      c.bw >= 5 &&
      c.bh >= 5 &&
      c.bw <= gray.width * 0.045 &&
      c.bh <= gray.height * 0.045 &&
      c.fill >= 0.35 &&
      c.bw / c.bh >= 0.45 &&
      c.bw / c.bh <= 2.2
    )
    .map(c => {
      const expected = {
        x: expectedNorm.x * gray.width,
        y: expectedNorm.y * gray.height
      };
      const distance = dist(c, expected);
      const squarePenalty = Math.abs(1 - c.bw / c.bh) * 80;
      const sizeBonus = Math.min(c.count, 220) * 0.25;
      const score = distance + squarePenalty - sizeBonus;
      return { ...c, score };
    })
    .sort((a, b) => a.score - b.score);

  if (!candidates.length) return null;
  return { x: candidates[0].x, y: candidates[0].y };
}

function findMarkers(gray) {
  /*
    Zonas deliberadamente estreitas para não confundir texto/bordas
    com os quadrados de registro.

    IMPORTANTE: alguns scanners podem cortar/remover um ou mais
    marcadores. Por isso, se não encontrarmos todos, usamos a geometria
    de referência somente quando o tamanho/aspecto da página é compatível.
    Isso permite ler uma folha em branco ou uma página com marcador
    parcialmente perdido sem derrubar o PDF inteiro.
  */
  const zones = {
    tl: {
      zone: { x0: 0.095, x1: 0.165, y0: 0.145, y1: 0.205 },
      expected: { x: 119 / 893, y: 212 / 1263 }
    },
    tr: {
      zone: { x0: 0.865, x1: 0.935, y0: 0.145, y1: 0.205 },
      expected: { x: 812 / 893, y: 214 / 1263 }
    },
    bl: {
      zone: { x0: 0.09, x1: 0.165, y0: 0.855, y1: 0.92 },
      expected: { x: 114 / 893, y: 1118 / 1263 }
    },
    br: {
      zone: { x0: 0.86, x1: 0.935, y0: 0.855, y1: 0.92 },
      expected: { x: 807 / 893, y: 1120 / 1263 }
    }
  };

  const markers = {};
  for (const [key, z] of Object.entries(zones)) {
    markers[key] = chooseMarker(gray, z.zone, z.expected);
  }

  const missing = Object.entries(markers)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length === 0) {
    return {
      ...markers,
      _mode: "detected",
      _missing: []
    };
  }

  // Fallback: se a página mantém o A4 inteiro, a geometria normalizada
  // continua válida mesmo que algum quadrado tenha sido cortado pelo scan.
  // Não usamos isso quando a proporção da página está muito diferente.
  const aspect = gray.width / gray.height;
  const expectedAspect = BASE.width / BASE.height;
  const aspectError = Math.abs(aspect - expectedAspect) / expectedAspect;

  if (aspectError <= 0.035) {
    const fallback = {
      tl: markers.tl || {
        x: (BASE.markers.tl.x / BASE.width) * gray.width,
        y: (BASE.markers.tl.y / BASE.height) * gray.height
      },
      tr: markers.tr || {
        x: (BASE.markers.tr.x / BASE.width) * gray.width,
        y: (BASE.markers.tr.y / BASE.height) * gray.height
      },
      bl: markers.bl || {
        x: (BASE.markers.bl.x / BASE.width) * gray.width,
        y: (BASE.markers.bl.y / BASE.height) * gray.height
      },
      br: markers.br || {
        x: (BASE.markers.br.x / BASE.width) * gray.width,
        y: (BASE.markers.br.y / BASE.height) * gray.height
      },
      _mode: "fallback",
      _missing: missing
    };

    console.warn(
      `[OMR] Marcadores ausentes (${missing.join(", ")}). ` +
      `Usando geometria de referência para esta página.`
    );

    return fallback;
  }

  throw new Error(
    `Não consegui localizar os marcadores: ${missing.join(", ")}. ` +
    `A página parece estar cortada ou fora do formato esperado.`
  );
}

function sampleFill(gray, center, radius) {
  /*
    Amostramos o MIOLO da bolinha, não o contorno.
    Isso evita considerar o círculo impresso como resposta marcada.
  */
  const r = Math.max(3, radius);
  const inner = r * 0.80;

  let dark = 0;
  let total = 0;
  let sum = 0;

  const minX = Math.floor(center.x - inner);
  const maxX = Math.ceil(center.x + inner);
  const minY = Math.floor(center.y - inner);
  const maxY = Math.ceil(center.y + inner);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > inner * inner) continue;

      const val = getPixel(gray, x, y);
      total++;
      sum += val;
      if (val < CONFIG.MARK_THRESHOLD) dark++;
    }
  }

  return {
    ratio: total ? dark / total : 0,
    avg: total ? sum / total : 255
  };
}

function estimateScale(markers) {
  const baseHorizontal = dist(BASE.markers.tl, BASE.markers.tr);
  const pageHorizontal = dist(markers.tl, markers.tr);
  return pageHorizontal / baseHorizontal;
}

function interpretQuestion(samples) {
  const strong = samples.filter(s => s.ratio >= CONFIG.FILL_THRESHOLD);

  if (strong.length === 0) {
    const ordered = [...samples].sort((a, b) => b.ratio - a.ratio);
    const best = ordered[0];

    // "maybe" serve para o diagnóstico, mas não vira resposta automaticamente.
    return {
      status: "blank",
      answer: null,
      marked: [],
      confidence: Math.max(0, 1 - best.ratio / CONFIG.FILL_THRESHOLD),
      maybe:
        best.ratio >= CONFIG.MAYBE_THRESHOLD
          ? best.alternative
          : null
    };
  }

  if (strong.length > 1) {
    return {
      status: "double",
      answer: null,
      marked: strong
        .sort((a, b) => b.ratio - a.ratio)
        .map(s => s.alternative),
      confidence: Math.min(1, strong[1].ratio / CONFIG.FILL_THRESHOLD),
      maybe: null
    };
  }

  const chosen = strong[0];
  const others = samples
    .filter(s => s.alternative !== chosen.alternative)
    .sort((a, b) => b.ratio - a.ratio);

  const separation = chosen.ratio - (others[0]?.ratio || 0);

  return {
    status: "marked",
    answer: chosen.alternative,
    marked: [chosen.alternative],
    confidence: clamp(
      0.55 +
      (chosen.ratio - CONFIG.FILL_THRESHOLD) * 1.3 +
      separation * 0.9,
      0,
      1
    ),
    maybe: null
  };
}

async function readOmrPage(buffer, pageNumber) {
  const gray = await grayscaleRaw(buffer);
  const markers = findMarkers(gray);
  const scale = estimateScale(markers);

  const results = [];

  for (const q of QUESTION_POINTS) {
    const samples = q.choices.map(choice => {
      const { u, v } = baseToUV(choice.x, choice.y);
      const point = mapUVToPage(u, v, markers);

      const sample = sampleFill(
        gray,
        point,
        CONFIG.SAMPLE_RADIUS_BASE * scale
      );

      return {
        alternative: choice.alternative,
        x: Math.round(point.x),
        y: Math.round(point.y),
        ratio: Number(sample.ratio.toFixed(4)),
        avg: Number(sample.avg.toFixed(1))
      };
    });

    const interpretation = interpretQuestion(samples);

    results.push({
      question: q.question,
      ...interpretation,
      samples
    });
  }

  return {
    page: pageNumber,
    width: gray.width,
    height: gray.height,
    markers,
    results,
    summary: {
      marked: results.filter(r => r.status === "marked").length,
      blank: results.filter(r => r.status === "blank").length,
      double: results.filter(r => r.status === "double").length
    }
  };
}

function parseAnswerKey(raw) {
  if (!raw || typeof raw !== "string") return null;

  const normalized = raw
    .toUpperCase()
    .replace(/[^ABCDE]/g, "");

  if (!normalized) return null;

  if (normalized.length !== 35) {
    throw new Error(
      `O gabarito precisa ter exatamente 35 alternativas. Recebi ${normalized.length}.`
    );
  }

  return normalized.split("");
}

function gradePage(pageResult, answerKey) {
  if (!answerKey) return null;

  let correct = 0;
  let wrong = 0;
  let blank = 0;
  let invalid = 0;

  const detail = pageResult.results.map((r, idx) => {
    const expected = answerKey[idx];

    if (r.status === "blank") {
      blank++;
      return { question: r.question, expected, result: "blank", correct: false };
    }

    if (r.status === "double") {
      invalid++;
      return {
        question: r.question,
        expected,
        result: r.marked.join("+"),
        correct: false
      };
    }

    const ok = r.answer === expected;
    if (ok) correct++;
    else wrong++;

    return {
      question: r.question,
      expected,
      result: r.answer,
      correct: ok
    };
  });

  return {
    correct,
    wrong,
    blank,
    invalid,
    score: Number(((correct / 35) * 10).toFixed(2)),
    detail
  };
}

app.post("/api/ler", upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Selecione um arquivo." });
    }

    const answerKey = parseAnswerKey(req.body.gabarito || "");
    const images = await fileToImages(req.file);

    if (images.length > 100) {
      return res.status(400).json({
        error: "Por segurança, processe no máximo 100 páginas por arquivo."
      });
    }

    const pages = [];
    for (let i = 0; i < images.length; i++) {
      const result = await readOmrPage(images[i], i + 1);
      result.grading = gradePage(result, answerKey);
      pages.push(result);
    }

    return res.json({
      ok: true,
      filename: req.file.originalname,
      pageCount: pages.length,
      answerKey: answerKey ? answerKey.join("") : null,
      config: {
        fillThreshold: CONFIG.FILL_THRESHOLD,
        maybeThreshold: CONFIG.MAYBE_THRESHOLD
      },
      pages
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || "Erro inesperado ao processar o arquivo."
    });
  }
});

app.post("/api/ler-gabarito", upload.single("gabarito"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Selecione o arquivo do gabarito oficial."
      });
    }

    const images = await fileToImages(req.file);

    if (images.length !== 1) {
      return res.status(400).json({
        error: "O gabarito oficial deve conter exatamente 1 página."
      });
    }

    const result = await readOmrPage(images[0], 1);

    const problemas = result.results.filter(
      r => r.status !== "marked"
    );

    if (problemas.length > 0) {
      const lista = problemas
        .map(r => {
          if (r.status === "blank") {
            return `Q${String(r.question).padStart(2, "0")}: em branco`;
          }

          return `Q${String(r.question).padStart(2, "0")}: dupla (${r.marked.join(" + ")})`;
        })
        .join("; ");

      return res.status(400).json({
        error:
          `Não foi possível criar o gabarito porque existem questões ` +
          `sem uma única resposta válida: ${lista}`
      });
    }

    const answerKey = result.results.map(r => r.answer);

    return res.json({
      ok: true,
      filename: req.file.originalname,
      answerKey,
      answerKeyString: answerKey.join(","),
      results: result.results,
      summary: result.summary
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        error.message ||
        "Erro inesperado ao ler o gabarito oficial."
    });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    service: "Leitor OMR",
    questions: 35,
    alternatives: ALTERNATIVES
  });
});

app.listen(PORT, () => {
  console.log("");
  console.log("========================================");
  console.log(" LEITOR OMR - CARTÃO RESPOSTA 35 QUESTÕES");
  console.log("========================================");
  console.log(` Acesse: http://localhost:${PORT}`);
  console.log("");
});
