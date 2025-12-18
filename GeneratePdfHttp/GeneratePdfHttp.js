// GeneratePdfHttp/GeneratePdfHttp.js
// Azure Functions Node.js v4 – Queue Trigger (jobs) -> Gotenberg -> Blob -> Queue (results)
// Adaptado ao teu worker atual (mantém compatibilidade com payload "flat" e com payload antigo "data")

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const { QueueServiceClient } = require("@azure/storage-queue");
const FormData = require("form-data");

// ENV
const GOTENBERG_URL = process.env.GOTENBERG_URL; // ex: https://.../forms/chromium/convert/html
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

// Blob
const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";

// Queue trigger (jobs)
const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE"; // App Setting com connection string completa
const QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";

// Results queue (para o Flow "PDF Results")
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
// Se quiseres usar outra storage para results, define PDF_RESULTS_CONNECTION_STRING.
// Caso contrário, usa a mesma do QUEUE_CONNECTION (mesma storage account).
const RESULTS_CONN_STR =
  process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];

// Helpers
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
  // Aceita: [{t:"..."}, ...], [{Value:"..."}, ...] ou ["...", ...]
  if (!arrOrNull) return [];
  if (!Array.isArray(arrOrNull)) return [];

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
  // payload novo: payload.dataverse.{table,rowId,fileColumn,fileName}
  const dv = payload?.dataverse;
  if (!dv || typeof dv !== "object") return null;

  const table = safeString(dv.table).trim();
  const rowId = safeString(dv.rowId).trim();
  const fileColumn = safeString(dv.fileColumn).trim();
  const fileName = safeString(dv.fileName).trim();

  if (!table || !rowId || !fileColumn) return null;

  return {
    table,
    rowId,
    fileColumn,
    fileName: fileName || "relatorio.pdf",
  };
}

async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) {
    context.log(
      "AVISO: RESULTS_CONN_STR vazio. Define PDF_RESULTS_CONNECTION_STRING ou garante que a App Setting indicada em PDF_QUEUE_CONNECTION existe."
    );
    return;
  }

  const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
  const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
  await qc.createIfNotExists();

  await qc.sendMessage(JSON.stringify(resultObj));
  context.log(`Mensagem enviada para results queue: ${RESULTS_QUEUE_NAME}`);
}

app.storageQueue("GeneratePdfFromQueue", {
  queueName: QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    const startedAtUtc = new Date().toISOString();

    context.log(`Queue trigger recebido. queue=${QUEUE_NAME}`);

    // Guardrails ENV
    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      context.log("ERRO: Missing GOTENBERG_URL or AZURE_STORAGE_CONNECTION_STRING.");
      throw new Error("Missing GOTENBERG_URL or AZURE_STORAGE_CONNECTION_STRING");
    }

    // Parse payload
    let payload;
    try {
      payload = parseQueueMessage(queueItem) || {};
    } catch (e) {
      context.log(`ERRO: JSON inválido na queue: ${e.message}`);
      throw new Error("Invalid JSON in queue message");
    }

    // Compatibilidade: payload "flat" OU payload antigo com "data"
    const data = payload.data ?? payload;

    // reportId
    const reportId = payload.reportId ?? payload.header?.reportNumber;
    if (!reportId) {
      context.log("ERRO: payload sem reportId (nem header.reportNumber).");
      throw new Error("Invalid queue message: missing reportId");
    }

    // Dataverse routing (opcional, mas recomendado)
    const dataverse = pickDataverse(payload);

    // Normalizar campos para o Mustache
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
    };

    // Log do tamanho do item (sem despejar conteúdo)
    try {
      const raw = typeof queueItem === "string" ? queueItem : JSON.stringify(queueItem);
      context.log(`Queue item size (chars): ${raw.length}`);
    } catch {}

    context.log(`A gerar PDF para reportId=${viewModel.reportId}`);

    // 1) Template HTML
    const templatePath = path.join(__dirname, "Preventiva.html");
    if (!fs.existsSync(templatePath)) {
      context.log(`ERRO: Preventiva.html não encontrado em: ${templatePath}`);

      const fail = {
        version: 1,
        reportId: viewModel.reportId,
        status: "FAILED",
        createdAtUtc: new Date().toISOString(),
        source: dataverse ? { dataverse } : undefined,
        pdf: {
          containerName: CONTAINER_NAME,
          blobName: `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/"),
          contentType: "application/pdf",
        },
        error: {
          code: "TEMPLATE_NOT_FOUND",
          message: "Preventiva.html não encontrado no deploy",
          details: templatePath,
        },
      };

      await sendResultMessage(fail, context);
      throw new Error("Preventiva.html not found in deployment");
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
      const status = err?.response?.status;
      const details =
        err?.response?.data
          ? Buffer.from(err.response.data).toString("utf8").slice(0, 1000)
          : err?.message;

      context.log(`ERRO GOTENBERG: status=${status || "N/A"} details=${details}`);

      const fail = {
        version: 1,
        reportId: viewModel.reportId,
        status: "FAILED",
        createdAtUtc: new Date().toISOString(),
        source: dataverse ? { dataverse } : undefined,
        pdf: {
          containerName: CONTAINER_NAME,
          blobName: `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/"),
          contentType: "application/pdf",
        },
        error: {
          code: "GOTENBERG_FAILED",
          message: `Gotenberg failed: ${status || "unknown"}`,
          details,
        },
      };

      await sendResultMessage(fail, context);
      throw new Error(`Gotenberg failed: ${status || "unknown"}`);
    }

    // 3) Upload Blob
    let blobUrl = "";
    const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");

    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        AZURE_STORAGE_CONNECTION_STRING
      );

      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });

      blobUrl = blockBlobClient.url;
      context.log(`PDF criado com sucesso: ${blobUrl}`);
    } catch (err) {
      context.log(`ERRO BLOB UPLOAD: ${err?.message || String(err)}`);

      const fail = {
        version: 1,
        reportId: viewModel.reportId,
        status: "FAILED",
        createdAtUtc: new Date().toISOString(),
        source: dataverse ? { dataverse } : undefined,
        pdf: {
          containerName: CONTAINER_NAME,
          blobName,
          contentType: "application/pdf",
        },
        error: {
          code: "BLOB_UPLOAD_FAILED",
          message: "Blob upload failed",
          details: safeString(err?.message || err),
        },
      };

      await sendResultMessage(fail, context);
      throw new Error("Blob upload failed");
    }

    // 4) Enviar resultado (SUCCEEDED) para a results queue
    const ok = {
      version: 1,
      reportId: viewModel.reportId,
      status: "SUCCEEDED",
      createdAtUtc: new Date().toISOString(),
      source: dataverse ? { dataverse } : undefined,
      pdf: {
        containerName: CONTAINER_NAME,
        blobName,
        blobUrl,
        contentType: "application/pdf",
        sizeBytes: pdfBuffer.length, // origem: pdfBuffer.length (nº de bytes)
      },
    };

    await sendResultMessage(ok, context);
  },
});
