// GeneratePdfHttp/GeneratePdfHttp.js
const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const { QueueServiceClient } = require("@azure/storage-queue");
const FormData = require("form-data");

const GOTENBERG_URL = process.env.GOTENBERG_URL; 
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";
const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE"; 

app.storageQueue("GeneratePdfFromQueue", {
  queueName: process.env.PDF_QUEUE_NAME || "pdf-generation-jobs",
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    const reportId = (typeof queueItem === 'object' && queueItem.reportId) ? queueItem.reportId : "unknown";
    context.log(`[START] Iniciando processamento do Relatório: ${reportId}`);

    try {
      const payload = (typeof queueItem === "string") ? JSON.parse(queueItem) : queueItem;
      const data = payload.data ?? payload;
      
      // 1. Preparar Dados
      context.log(`[STEP 1] Preparando ViewModel...`);
      const viewModel = {
        reportId: String(data.reportId || data.header?.reportNumber || "SemID"),
        header: data.header,
        cliente: data.cliente,
        relatorio: data.relatorio,
        maoObra: Array.isArray(data.maoObra) ? data.maoObra : [],
        material: Array.isArray(data.material) ? data.material : [],
        fotos: Array.isArray(data.fotos) ? data.fotos.map(f => (typeof f === "string" ? f : (f.Value || f.Result || ""))) : [],
        temFotos: data.fotos?.length > 0
      };

      // 2. Renderizar
      context.log(`[STEP 2] Renderizando HTML com Mustache...`);
      const templatePath = path.join(__dirname, "Preventiva.html");
      const htmlTemplate = fs.readFileSync(templatePath, "utf8");
      const renderedHtml = mustache.render(htmlTemplate, viewModel);

      // 3. Gotenberg
      context.log(`[STEP 3] Enviando para Gotenberg (${viewModel.fotos.length} fotos)...`);
      const form = new FormData();
      form.append("files", Buffer.from(renderedHtml, "utf8"), { filename: "index.html", contentType: "text/html" });
      form.append("pdfFormat", "PDF/A-1b");

      const response = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000 // Aumentado para 2 min
      });
      const pdfBuffer = Buffer.from(response.data);
      context.log(`[STEP 3] Gotenberg respondeu com sucesso. Tamanho: ${pdfBuffer.length} bytes`);

      // 4. Upload
      context.log(`[STEP 4] Fazendo upload para o Blob Storage...`);
      const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(pdfBuffer, { blobHTTPHeaders: { blobContentType: "application/pdf" } });

      context.log(`[SUCCESS] Relatório ${viewModel.reportId} concluído e guardado.`);

    } catch (err) {
      context.log.error(`[FATAL ERROR] Erro no processamento: ${err.message}`);
      if (err.response) context.log.error(`[DEBUG] Resposta do Servidor: ${err.response.status}`);
      throw err; // Força a mensagem a voltar para a queue se falhar
    }
  },
});
