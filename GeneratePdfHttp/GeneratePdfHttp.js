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

/**
 * Envia a mensagem de sucesso de volta para a Queue de resultados (pdf-results)
 */
async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) {
    context.log.warn("[QUEUE] RESULTS_CONN_STR não definida. Ignorando envio de resultado.");
    return;
  }
  try {
    const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
    const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
    await qc.createIfNotExists();
    
    const messageText = JSON.stringify(resultObj);
    // O Power Automate requer que a mensagem de fila esteja em Base64
    await qc.sendMessage(Buffer.from(messageText).toString('base64'));
    context.log(`[QUEUE] Resultado enviado com sucesso para: ${RESULTS_QUEUE_NAME}`);
  } catch (err) {
    context.log.error(`[QUEUE ERROR] Erro ao enviar resultado: ${err.message}`);
  }
}

/**
 * Corrige o erro [object Object] extraindo o texto real das listas do Dataverse
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
        // Tenta capturar o campo de texto (Value, Name ou Result)
        const val = item.Value || item.Result || item.Name || item.Label || item.t || "";
        if (val) items.push(val);
      }
    });
  }
  
  return items
    .map(s => String(s).trim())
    .filter(s => s.length > 0 && s !== "[object Object]");
}

// --- HANDLER PRINCIPAL ---

app.storageQueue("GeneratePdfFromQueue", {
  queueName: process.env.PDF_QUEUE_NAME || "pdf-generation-jobs",
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    // 1. Identificação Inicial
    let payload;
    try {
      payload = (typeof queueItem === "string") ? JSON.parse(queueItem) : queueItem;
    } catch (e) {
      context.log.error("Erro ao processar JSON da fila");
      throw e;
    }

    const data = payload.data ?? payload;
    const reportId = data.reportId || data.header?.reportNumber || "Relatorio_Sem_ID";
    
    context.log(`[START] Iniciando geração do PDF: ${reportId}`);

    try {
      // 2. Preparar ViewModel para o Template HTML
      const viewModel = {
        reportId: String(reportId),
        header: data.header || {},
        cliente: data.cliente || {},
        relatorio: data.relatorio || {},
        // Normalização crítica para evitar [object Object]
        maoObra: normalizeList(data.maoObra),
        material: normalizeList(data.material),
        // Fotos: Assume URLs já otimizadas no Power Automate
        fotos: Array.isArray(data.fotos) 
          ? data.fotos.map(f => (typeof f === "string" ? f : (f.Value || f.Result || ""))) 
          : [],
        temFotos: data.fotos && data.fotos.length > 0
      };

      // 3. Renderizar o HTML
      const templatePath = path.join(__dirname, "Preventiva.html");
      if (!fs.existsSync(templatePath)) {
        throw new Error(`Template não encontrado em: ${templatePath}`);
      }
      const htmlTemplate = fs.readFileSync(templatePath, "utf8");
      const renderedHtml = mustache.render(htmlTemplate, viewModel);

      // 4. Converter para PDF via Gotenberg
      context.log(`[STEP 3] Chamando Gotenberg para ${reportId}...`);
      const form = new FormData();
      form.append("files", Buffer.from(renderedHtml, "utf8"), { 
        filename: "index.html", 
        contentType: "text/html" 
      });
      form.append("pdfFormat", "PDF/A-1b");

      const response = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000 // 2 minutos para processar imagens
      });
      const pdfBuffer = Buffer.from(response.data);

      // 5. Upload para o Azure Blob Storage
      const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      
      await containerClient.createIfNotExists();
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      await blockBlobClient.uploadData(pdfBuffer, { 
        blobHTTPHeaders: { blobContentType: "application/pdf" } 
      });
      context.log(`[STEP 4] Upload concluído: ${blobName}`);

      // 6. Notificar Sucesso (pdf-results) para o Flow de retorno
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

      context.log(`[SUCCESS] Processamento concluído para ${reportId}`);

    } catch (err) {
      context.log.error(`[FATAL ERROR] Relatório ${reportId} falhou: ${err.message}`);
      // Re-lançar o erro garante que a mensagem volte para a queue em caso de falha temporária
      throw err; 
    }
  },
});
