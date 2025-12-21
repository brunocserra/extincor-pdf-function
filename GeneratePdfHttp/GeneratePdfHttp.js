"use strict";

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const sharp = require("sharp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { QueueServiceClient } = require("@azure/storage-queue");
const FormData = require("form-data");

// =====================
// CONFIG
// =====================
const GOTENBERG_URL = process.env.GOTENBERG_URL;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";

const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE";
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
const RESULTS_CONN_STR =
  process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];

const JOBS_QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";

// =====================
// HELPERS
// =====================

async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) return;

  try {
    const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
    const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
    await qc.createIfNotExists();

    const messageText = JSON.stringify(resultObj);
    await qc.sendMessage(Buffer.from(messageText).toString("base64"));

    context.log(`[QUEUE] Resultado enviado para ${RESULTS_QUEUE_NAME}`);
  } catch (err) {
    context.log.error(`[QUEUE ERROR] Erro ao enviar resultado: ${err.message}`);
  }
}

/**
 * Normaliza listas vindas como:
 * - string: "a;b;c"
 * - array: ["a;b;c"]  (caso típico: 1 string com ;)
 * - array: ["a","b","c"]
 * - array: [{Value:"..."}, {Name:"..."}]
 *
 * Resultado: ["a","b","c"] (cada item vira 1 <li>)
 */
function normalizeList(arrOrNull) {
  if (!arrOrNull) return [];

  const out = [];

  const pushSplit = (value) => {
    if (value == null) return;
    const str = String(value).trim();
    if (!str) return;

    // sempre parte por ; se existir
    const parts = str
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p !== "[object Object]");

    for (const p of parts) out.push(p);
  };

  if (typeof arrOrNull === "string") {
    pushSplit(arrOrNull);
    return out;
  }

  if (Array.isArray(arrOrNull)) {
    for (const item of arrOrNull) {
      if (typeof item === "string") {
        pushSplit(item);
        continue;
      }
      if (item && typeof item === "object") {
        const val =
          item.Value ??
          item.Result ??
          item.Name ??
          item.Label ??
          item.t ??
          "";
        pushSplit(val);
      }
    }
  }

  return out;
}

function safeJsonParse(input, context) {
  try {
    return typeof input === "string" ? JSON.parse(input) : input;
  } catch (e) {
    context.log.error("Erro no JSON da mensagem");
    throw e;
  }
}

async function fetchUrlToBuffer(url, context, label) {
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000
  });

  const buf = Buffer.from(r.data);
  context.log(`[FETCH] ${label || "asset"} bytes=${buf.length}`);
  return buf;
}

async function optimizePhotoToJpeg(inBuf, context, label) {
  // Ajusta estes valores conforme precisares
  const MAX_W = 1280; // 1024/1280 costuma ser suficiente em A4
  const QUALITY = 65; // 60-70 típico

  const outBuf = await sharp(inBuf)
    .rotate() // respeita orientação EXIF
    .resize({ width: MAX_W, withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer();

  context.log(`[OPT] ${label} in=${inBuf.length} out=${outBuf.length}`);
  return outBuf;
}

// =====================
// HANDLER
// =====================

app.storageQueue("GeneratePdfFromQueue", {
  queueName: JOBS_QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    const payload = safeJsonParse(queueItem, context);
    const data = payload?.data ?? payload ?? {};

    const reportId = data.reportId || data.header?.reportNumber || "Relatorio";
    context.log(`[START] Processando Relatório: ${reportId}`);

    try {
      if (!GOTENBERG_URL) throw new Error("GOTENBERG_URL não definido");
      if (!AZURE_STORAGE_CONNECTION_STRING) {
        throw new Error("AZURE_STORAGE_CONNECTION_STRING não definido");
      }

      // -----------------
      // 1) Fotos: URLs -> download -> optimize -> assets locais
      // (Logo mantém remoto no HTML, sem mexer)
      // -----------------
      const rawFotoUrls = normalizeList(data.fotos);

      const photoAssets = [];
      const localPhotoNames = [];

      for (let i = 0; i < rawFotoUrls.length; i++) {
        const url = rawFotoUrls[i];

        const inBuf = await fetchUrlToBuffer(url, context, `photo_${i + 1}`);
        const outBuf = await optimizePhotoToJpeg(inBuf, context, `photo_${i + 1}`);

        const filename = `img_${String(i + 1).padStart(2, "0")}.jpg`;
        photoAssets.push({ filename, buffer: outBuf, contentType: "image/jpeg" });
        localPhotoNames.push(filename);
      }

      // -----------------
      // 2) ViewModel (corrige bullets de mão de obra e material)
      // -----------------
      const viewModel = {
        reportId: String(reportId),
        header: data.header || {},
        cliente: data.cliente || {},
        relatorio: data.relatorio || {},
        maoObra: normalizeList(data.maoObra),
        material: normalizeList(data.material),
        fotos: localPhotoNames, // agora são filenames (img_01.jpg, ...)
        temFotos: localPhotoNames.length > 0
      };

      // -----------------
      // 3) Render HTML
      // IMPORTANTE:
      // - No teu Preventiva.html mantém o logo como URL (como pediste)
      // - Na secção das fotos, o <img src="{{.}}"> vai receber img_01.jpg, etc.
      // -----------------
      const templatePath = path.join(__dirname, "Preventiva.html");
      const htmlTemplate = fs.readFileSync(templatePath, "utf8");
      const renderedHtml = mustache.render(htmlTemplate, viewModel);

      // -----------------
      // 4) Gotenberg (HTML + fotos otimizadas como assets)
      // -----------------
      const form = new FormData();

      form.append("files", Buffer.from(renderedHtml, "utf8"), {
        filename: "index.html",
        contentType: "text/html"
      });

      for (const a of photoAssets) {
        form.append("files", a.buffer, {
          filename: a.filename,
          contentType: a.contentType
        });
      }

      // Mantive como tinhas; se quiseres reduzir ainda mais, testa remover esta linha
      form.append("pdfFormat", "PDF/A-1b");

      const response = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000
      });

      const pdfBuffer = Buffer.from(response.data);
      context.log(`[PDF] sizeBytes=${pdfBuffer.length}`);

      // -----------------
      // 5) Upload Blob
      // -----------------
      const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        AZURE_STORAGE_CONNECTION_STRING
      );
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" }
      });

      // -----------------
      // 6) Result para o Flow
      // -----------------
      await sendResultMessage(
        {
          version: 1,
          reportId: viewModel.reportId,
          status: "SUCCEEDED",
          createdAtUtc: new Date().toISOString(),
          source: {
            dataverse: {
              table: data.dataverse?.table || "cra4d_pedidosnovos",
              rowId: data.dataverse?.rowId,
              fileColumn: data.dataverse?.fileColumn || "cra4d_relatorio_pdf_relatorio",
              fileName: data.dataverse?.fileName || `${viewModel.reportId}.pdf`
            }
          },
          pdf: {
            containerName: CONTAINER_NAME,
            blobName,
            blobUrl: blockBlobClient.url,
            sizeBytes: pdfBuffer.length
          },
          images: {
            count: localPhotoNames.length
          }
        },
        context
      );

      context.log(
        `[SUCCESS] Relatório ${reportId} concluído | fotos=${localPhotoNames.length} | sizeBytes=${pdfBuffer.length}`
      );
    } catch (err) {
      context.log.error(`[FATAL ERROR] ${err.message}`);
      throw err;
    }
  }
});
