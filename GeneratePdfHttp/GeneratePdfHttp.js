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

/**
 * Nova versão da normalizeList:
 * 1. Converte objetos ou strings em texto simples.
 * 2. Se houver ";" no texto, divide em múltiplos itens (bullets).
 */
function normalizeList(arrOrNull) {
  if (!arrOrNull) return [];
  
  let items = [];
  
  // Se for uma string única (ex: vinda do Power Apps com ";")
  if (typeof arrOrNull === "string") {
    items = arrOrNull.split(';');
  } 
  // Se for um array de objetos ou strings
  else if (Array.isArray(arrOrNull)) {
    arrOrNull.forEach(item => {
      // Tenta extrair o texto de várias formas comuns (propriedade 't', 'Value' ou string direta)
      const text = typeof item === "string" ? item : (item.t || item.Value || "");
      
      if (text.includes(';')) {
        items.push(...text.split(';'));
      } else {
        items.push(text);
      }
    });
  }

  // Limpa espaços em branco e remove itens vazios
  return items.map(s => s.trim()).filter(s => s.length > 0);
}

async function sendResultMessage(resultObj, context) {
  if (!RESULTS_CONN_STR) return;
  try {
    const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
    const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
    await qc.createIfNotExists();
    await qc.sendMessage(JSON.stringify(resultObj));
  } catch (err) {
    context.log(`Erro ao enviar resultado: ${err.message}`);
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

    // Construção do ViewModel para o Mustache
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
      
      // Listas normalizadas para virarem bullets
      maoObra: normalizeList(data.maoObra),
      material: normalizeList(data.material),
      
      // Fotos e Flag de controlo para o HTML
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

    // 4. Notificar Sucesso
    await sendResultMessage({
      reportId: viewModel.reportId,
      status: "SUCCEEDED",
      pdfUrl: blockBlobClient.url
    }, context);

    context.log(`PDF gerado com sucesso para o relatório ${viewModel.reportId}`);
  },
});
