// GeneratePdfHttp/GeneratePdfHttp.js
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
const QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
const RESULTS_CONN_STR = process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];

// --- HELPERS ---

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
  if (!arrOrNull) return [];
  
  let items = [];
  
  if (typeof arrOrNull === "string") {
    items = arrOrNull.split(';');
  } 
  else if (Array.isArray(arrOrNull)) {
    arrOrNull.forEach(item => {
      const text = typeof item === "string" ? item : (item.t || item.Value || "");
      
      if (text.includes(';')) {
        items.push(...text.split(';'));
      } else {
        items.push(text);
      }
    });
  }

  return items.map(s => s.trim()).filter(s => s.length > 0);
}

async function sendResultMessage(resultObj, context) {
  // Tenta usar a string específica de resultados ou a geral da queue
  const connectionString = RESULTS_CONN_STR || process.env[QUEUE_CONNECTION];
  const queueName = RESULTS_QUEUE_NAME || "pdf-results";

  if (!connectionString) {
    context.log("ERRO: Nenhuma String de Ligação encontrada para a Queue de resultados.");
    return;
  }

  try {
    const qsc = QueueServiceClient.fromConnectionString(connectionString);
    const qc = qsc.getQueueClient(queueName);
    
    // Garante que a fila existe antes de enviar
    await qc.createIfNotExists();
    
    // Envia a mensagem convertida para Base64 (necessário para o Power Automate ler bem)
    const messageText = JSON.stringify(resultObj);
    await qc.sendMessage(Buffer.from(messageText).toString('base64'));
    
    context.log(`Mensagem enviada com sucesso para a fila: ${queueName}`);
  } catch (err) {
    context.log(`Erro crítico ao enviar resultado para a Queue: ${err.message}`);
  }
}

// --- HANDLER ---

app.storageQueue("GeneratePdfFromQueue", {
  queueName: QUEUE_NAME,
  connection: QUEUE_CONNECTION,

  handler: async (queueItem, context) => {
    context.log(`Processando mensagem da queue...`);

    let payload;
    try {
      payload = parseQueueMessage(queueItem) || {};
    } catch (e) {
      throw new Error("Invalid JSON in queue message");
    }

    const data = payload.data ?? payload;
    const reportId = payload.reportId ?? payload.header?.reportNumber;
    
    if (!reportId) throw new Error("Missing reportId");

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
      fotos: Array.isArray(data.fotos) ? data.fotos : [],
      temFotos: Array.isArray(data.fotos) && data.fotos.length > 0
    };

    // 1. Carregar e Renderizar HTML
    const templatePath = path.join(__dirname, "Preventiva.html");
    const htmlTemplate = fs.readFileSync(templatePath, "utf8");
    
    let renderedHtml;
    try {
      renderedHtml = mustache.render(htmlTemplate, viewModel);
    } catch (err) {
      context.log(`Erro no Mustache: ${err.message}`);
      throw err;
    }

    // 2. Enviar para o Gotenberg
    const form = new FormData();
    form.append("files", Buffer.from(renderedHtml, "utf8"), {
      filename: "index.html",
      contentType: "text/html",
    });

    let pdfBuffer;
    try {
      const response = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        timeout: 120000,
      });
      pdfBuffer = Buffer.from(response.data);
    } catch (err) {
      context.log(`Erro Gotenberg: ${err.message}`);
      throw err;
    }

    // 3. Upload para o Azure Blob
    const blobName = `${BLOB_PREFIX}${viewModel.reportId}.pdf`.replace(/\/{2,}/g, "/");
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    await containerClient.createIfNotExists();
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(pdfBuffer, {
      blobHTTPHeaders: { blobContentType: "application/pdf" },
    });

    // 4. Notificar Sucesso - ALTERADO PARA BATER COM O ESQUEMA DO FLOW
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
        contentType: "application/pdf",
        sizeBytes: pdfBuffer.length
      }
    }, context);

    context.log(`PDF gerado com sucesso para o relatório ${viewModel.reportId}`);
  },
});
