// GeneratePdfHttp/GeneratePdfHttp.js
// Azure Functions Node.js v4 – Queue Trigger

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const FormData = require("form-data");

// ENV
const GOTENBERG_URL = process.env.GOTENBERG_URL; // .../forms/chromium/convert/html
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "pdf-reports";

// Storage queue connection name (App Setting)
const QUEUE_CONNECTION = "PDF_QUEUE_STORAGE";
const QUEUE_NAME = "pdf-generation-jobs";

// Helper: parse seguro do payload
function parseQueueMessage(msg) {
  if (typeof msg === "string") return JSON.parse(msg);
  if (Buffer.isBuffer(msg)) return JSON.parse(msg.toString("utf8"));
  return msg; // já objeto
}

app.storageQueue("GeneratePdfFromQueue", {
  queueName: QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    context.log("Queue trigger recebido");

    // Guardrails
    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      context.log("ERRO: Variáveis de ambiente em falta");
      throw new Error("Missing GOTENBERG_URL or AZURE_STORAGE_CONNECTION_STRING");
      // throw => retry automático + poison queue se falhar
    }

const payload = parseQueueMessage(queueItem) || {};

// Aceitar payload antigo e novo
const data = payload.data ?? payload;

// reportId pode vir direto ou dentro do header
const reportId =
  payload.reportId ??
  payload.header?.reportNumber;

if (!reportId) {
  context.log("ERRO: payload sem reportId");
  throw new Error("Invalid queue message: missing reportId");
}

const logoUrl = payload.logoUrl ?? data.logoUrl ?? "";

context.log(`A gerar PDF para reportId=${reportId}`);


    context.log(`A gerar PDF para reportId=${reportId}`);

    // 1) Gerar HTML
    const templatePath = path.join(__dirname, "Preventiva.html");
    if (!fs.existsSync(templatePath)) {
      throw new Error("Preventiva.html não encontrado no deploy");
    }

    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    const renderedHtml = mustache.render(htmlTemplate, {
      reportId,
      logoUrl,
      ...data
    });

    // 2) HTML → PDF (Gotenberg)
    const form = new FormData();
    form.append("files", Buffer.from(renderedHtml, "utf8"), {
      filename: "index.html",
      contentType: "text/html"
    });

    const gotenbergResponse = await axios.post(GOTENBERG_URL, form, {
      responseType: "arraybuffer",
      headers: form.getHeaders(),
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const pdfBuffer = Buffer.from(gotenbergResponse.data);

    // 3) Upload para Blob Storage
    const blobServiceClient =
      BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

    const containerClient =
      blobServiceClient.getContainerClient(CONTAINER_NAME);

    await containerClient.createIfNotExists();

    const blobName = `relatorios/${reportId}.pdf`;
    const blockBlobClient =
      containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(pdfBuffer, {
      blobHTTPHeaders: { blobContentType: "application/pdf" }
    });

    context.log(`PDF criado com sucesso: ${blockBlobClient.url}`);
  }
});
