// GeneratePdfHttp/GeneratePdfHttp.js
// Azure Functions Node.js v4 – Queue Trigger (jobs) -> Gotenberg -> Blob -> Queue (results)

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const { QueueServiceClient } = require("@azure/storage-queue");
const FormData = require("form-data");

// ENV
const GOTENBERG_URL = process.env.GOTENBERG_URL; 
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";
const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE"; 
const QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
const RESULTS_CONN_STR = process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];

// --- HELPERS ORIGINAIS (MANTIDOS) ---
function parseQueueMessage(msg) {
  if (typeof msg === "string") return JSON.parse(msg);
  if (Buffer.isBuffer(msg)) return JSON.parse(msg.toString("utf8"));
  return msg;
}

function safeString(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeList(arrOrNull) {
  if (!arrOrNull || !Array.isArray(arrOrNull)) return [];
  return arrOrNull
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") {
        if (typeof x.t === "string") return x.t.trim();
        if (typeof x.Value === "string") return x.Value.trim();
      }
      return "";
    })
    .filter((s) => s.length > 0);
}

function pickDataverse(payload) {
  const dv = payload?.dataverse;
  if (!dv || typeof dv !== "object") return null;
  const table = safeString(dv.table).trim();
  const rowId = safeString(dv.rowId).trim();
  const fileColumn = safeString(dv.fileColumn).trim();
  const fileName = safeString(dv.fileName).trim();
  if (!table || !rowId || !fileColumn) return null;
  return { table, rowId, fileColumn, fileName: fileName || "relatorio.pdf" };
}

async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) {
    context.log("AVISO: RESULTS_CONN_STR vazio.");
    return;
  }
  const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
  const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
  await qc.createIfNotExists();
  await qc.sendMessage(JSON.stringify(resultObj));
  context.log(`Mensagem enviada para results queue: ${RESULTS_QUEUE_NAME}`);
}

// --- HANDLER PRINCIPAL ---
app.storageQueue("GeneratePdfFromQueue", {
  queueName: QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    const startedAtUtc = new Date().toISOString();
    context.log(`Queue trigger recebido. queue=${QUEUE_NAME}`);

    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      throw new Error("Missing GOTENBERG_URL or AZURE_STORAGE_CONNECTION_STRING");
    }

    let payload;
    try {
      payload = parseQueueMessage(queueItem) || {};
    } catch (e) {
      throw new Error("Invalid JSON in queue message");
    }

    const data = payload.data ?? payload;
    const reportId = payload.reportId ?? payload.header?.reportNumber;
    if (!reportId) throw new Error("Invalid queue message: missing reportId");

    const dataverse = pickDataverse(payload);

    // viewModel para o Mustache (INCLUINDO AS FOTOS)
    const viewModel = {
      reportId: safeString(reportId),
      header: {
        reportNumber: safeString(data.header?.reportNumber ?? reportId),
        date: safeString(data.header?.date),
      },
      cliente: {
        nif: safeString(data.cliente?.nif),
        nome: safeString(data.cliente?.nome),
        morada: safeString(data.cliente?.morada),
        email: safeString(data.cliente?.email),
      },
      relatorio: {
        tipo: safeString(data.relatorio?.tipo),
        area: safeString(data.relatorio?.area),
        descricao: safeString(data.relatorio?.descricao),
        observacoes: safeString(data.relatorio?.observacoes),
        situacaoFinal: safeString(data.relatorio?.situacaoFinal),
      },
      maoObra: normalizeList(data.maoObra),
      material: normalizeList(data.material),
      // Adicionado: suporte para o array de URLs das fotos
      fotos: Array.isArray(data.fotos) ? data.fotos : []
    };

    context.log(`A gerar PDF para reportId=${viewModel.reportId}. Fotos: ${viewModel.fotos.length}`);

    // 1) Template HTML
    const templatePath = path.join(__dirname, "Preventiva.html");
    if (!fs.existsSync(templatePath)) {
      const fail = {
        version: 1, reportId: viewModel.reportId, status: "FAILED", createdAtUtc: new Date().toISOString(),
        error: { code: "TEMPLATE_NOT_FOUND", message: "Preventiva.html não encontrado" }
      };
      await sendResultMessage(fail, context);
      throw new Error("Preventiva.html not found");
    }

    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    const renderedHtml = mustache.render(htmlTemplate, viewModel);

    // 2) HTML -> PDF (Gotenberg)
    const form = new FormData();
    form.append("files", Buffer.from(renderedHtml, "utf8"), {
      filename: "index.html",
      contentType: "text/html",
    });

    let pdfBuffer;
    try {
      const gotenbergResponse = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      pdfBuffer = Buffer.from(gotenbergResponse.data);
    } catch (err) {
      const fail = {
        version: 1, reportId: viewModel.reportId, status: "FAILED", createdAtUtc: new Date().toISOString(),
        error: { code: "GOTENBERG_FAILED", message: err.message }
      };
      await sendResultMessage(fail, context);
      throw err;
    }

    // 3) Upload Blob
    let blobUrl = "";
    const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });
      blobUrl = blockBlobClient.url;
    } catch (err) {
      const fail = {
        version: 1, reportId: viewModel.reportId, status: "FAILED", createdAtUtc: new Date().toISOString(),
        error: { code: "BLOB_UPLOAD_FAILED", message: err.message }
      };
      await sendResultMessage(fail, context);
      throw err;
    }

    // 4) Sucesso
    const ok = {
      version: 1,
      reportId: viewModel.reportId,
      status: "SUCCEEDED",
      createdAtUtc: new Date().toISOString(),
      source: dataverse ? { dataverse } : undefined,
      pdf: { containerName: CONTAINER_NAME, blobName, blobUrl, contentType: "application/pdf", sizeBytes: pdfBuffer.length },
    };
    await sendResultMessage(ok, context);
  },
});
