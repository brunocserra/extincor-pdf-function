const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const { QueueServiceClient } = require("@azure/storage-queue");
const FormData = require("form-data");

// CONFIGURAÇÕES DE AMBIENTE
const GOTENBERG_URL = process.env.GOTENBERG_URL; 
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";
const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE"; 
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
const RESULTS_CONN_STR = process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];

// --- HELPERS ---

async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) return;
  try {
    const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
    const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
    await qc.createIfNotExists();
    const messageText = JSON.stringify(resultObj);
    await qc.sendMessage(Buffer.from(messageText).toString('base64'));
    context.log(`[QUEUE] Resultado enviado para ${RESULTS_QUEUE_NAME}`);
  } catch (err) {
    context.log.error(`[QUEUE ERROR] Erro ao enviar resultado: ${err.message}`);
  }
}

/**
 * Função Universal para extrair texto e evitar [object Object]
 * Funciona para Mão de Obra, Material e URLs de Fotos
 */
function normalizeList(arrOrNull) {
  if (!arrOrNull) return [];
  let items = [];
  
  if (typeof arrOrNull === "string") {
    items = arrOrNull.split(';');
  } else if (Array.isArray(arrOrNull)) {
    arrOrNull.forEach(item => {
      if (typeof item === "string") {
        items.push(item);
      } else if (item && typeof item === "object") {
        // Tenta extrair o valor de campos comuns (Value para fotos, Name para listas)
        const val = item.Value || item.Result || item.Name || item.Label || item.t || "";
        if (val) items.push(val);
      }
    });
  }
  
  return items
    .map(s => String(s).trim())
    .filter(s => s.length > 0 && s !== "[object Object]");
}

// --- HANDLER ---

app.storageQueue("GeneratePdfFromQueue", {
  queueName: process.env.PDF_QUEUE_NAME || "pdf-generation-jobs",
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    let payload;
    try {
      payload = (typeof queueItem === "string") ? JSON.parse(queueItem) : queueItem;
    } catch (e) {
      context.log.error("Erro no JSON da mensagem");
      throw e;
    }

    const data = payload.data ?? payload;
    const reportId = data.reportId || data.header?.reportNumber || "Relatorio";
    
    context.log(`[START] Processando Relatório: ${reportId}`);

    try {
      // 1. Preparar ViewModel com limpeza em todos os arrays
      const viewModel = {
        reportId: String(reportId),
        header: data.header || {},
        cliente: data.cliente || {},
        relatorio: data.relatorio || {},
        // Correção para listas
        maoObra: normalizeList(data.maoObra),
        material: normalizeList(data.material),
        // CORREÇÃO PARA FOTOS (Usa a mesma lógica de limpeza)
        fotos: normalizeList(data.fotos),
        temFotos: false
      };
      
      viewModel.temFotos = viewModel.fotos.length > 0;

      // 2. Renderizar HTML
      const templatePath = path.join(__dirname, "Preventiva.html");
      const htmlTemplate = fs.readFileSync(templatePath, "utf8");
      const renderedHtml = mustache.render(htmlTemplate, viewModel);

      // 3. Gotenberg
      const form = new FormData();
      form.append("files", Buffer.from(renderedHtml, "utf8"), { filename: "index.html", contentType: "text/html" });
      form.append("pdfFormat", "PDF/A-1b");

      const response = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000 
      });
      const pdfBuffer = Buffer.from(response.data);

      // 4. Upload para o Blob
      const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(pdfBuffer, { blobHTTPHeaders: { blobContentType: "application/pdf" } });

      // 5. Enviar Resultado para o Flow
      await sendResultMessage({
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
          blobName: blobName,
          blobUrl: blockBlobClient.url,
          sizeBytes: pdfBuffer.length
        }
      }, context);

      context.log(`[SUCCESS] Relatório ${reportId} concluído com ${viewModel.fotos.length} fotos.`);

    } catch (err) {
      context.log.error(`[FATAL ERROR] ${err.message}`);
      throw err; 
    }
  },
});
