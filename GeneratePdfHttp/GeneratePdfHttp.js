// GeneratePdfHttp/GeneratePdfHttp.js
// Azure Functions Node.js v4 – Queue Trigger (robusto p/ payload "flat" do Power Apps)

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const FormData = require("form-data");

// ENV
const GOTENBERG_URL = process.env.GOTENBERG_URL; // ex: https://.../forms/chromium/convert/html
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "pdf-reports";

// Queue trigger binding
const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE"; // App Setting com connection string completa
const QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";

// Helpers
function parseQueueMessage(msg) {
  if (typeof msg === "string") return JSON.parse(msg);
  if (Buffer.isBuffer(msg)) return JSON.parse(msg.toString("utf8"));
  return msg; // já objeto (menos comum)
}

function safeString(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeList(arrOrNull) {
  // Esperamos: [{t:"..."}, ...] (como no teu Power Fx)
  // Aceitamos: ["...", ...] também.
  if (!arrOrNull) return [];
  if (!Array.isArray(arrOrNull)) return [];

  return arrOrNull
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") {
        if (typeof x.t === "string") return x.t.trim();
        if (typeof x.Value === "string") return x.Value.trim(); // fallback p/ payload antigo
      }
      return "";
    })
    .filter((s) => s.length > 0);
}

app.storageQueue("GeneratePdfFromQueue", {
  queueName: QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    context.log(`Queue trigger recebido. queue=${QUEUE_NAME}`);

    // Guardrails de ENV
    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      context.log(
        "ERRO: Missing GOTENBERG_URL or AZURE_STORAGE_CONNECTION_STRING (App Settings)."
      );
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

    // Aceitar payload "flat" OU payload antigo com "data"
    const data = payload.data ?? payload;

    // reportId: obrigatório
    const reportId = payload.reportId ?? payload.header?.reportNumber;
    if (!reportId) {
      context.log("ERRO: payload sem reportId (nem header.reportNumber).");
      throw new Error("Invalid queue message: missing reportId");
    }

    // Normalizar campos esperados no HTML
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
        observacoes: safeString(data.relatorio?.observacoes), // pode ser ""
        situacaoFinal: safeString(data.relatorio?.situacaoFinal),
      },

      // listas (para Mustache: {{#maoObra}}<li>{{.}}</li>{{/maoObra}})
      maoObra: normalizeList(data.maoObra),
      material: normalizeList(data.material),
    };

    // Logs úteis (sem despejar base64)
    try {
      const raw =
        typeof queueItem === "string" ? queueItem : JSON.stringify(queueItem);
      context.log(`Queue item size (chars): ${raw.length}`);
    } catch {
      // ignore
    }
    context.log(`A gerar PDF para reportId=${viewModel.reportId}`);

    // 1) Ler template HTML (Mustache)
    const templatePath = path.join(__dirname, "Preventiva.html");
    if (!fs.existsSync(templatePath)) {
      context.log(`ERRO: Preventiva.html não encontrado em: ${templatePath}`);
      throw new Error("Preventiva.html not found in deployment");
    }

    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    const renderedHtml = mustache.render(htmlTemplate, viewModel);

    // 2) HTML → PDF (Gotenberg)
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
      throw new Error(`Gotenberg failed: ${status || "unknown"}`);
    }

    // 3) Upload para Blob Storage
    try {
      const blobServiceClient =
        BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();

      const blobName = `relatorios/${viewModel.reportId}.pdf`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" },
      });

      context.log(`PDF criado com sucesso: ${blockBlobClient.url}`);
    } catch (err) {
      context.log(`ERRO BLOB UPLOAD: ${err?.message || String(err)}`);
      throw new Error("Blob upload failed");
    }
  },
});
