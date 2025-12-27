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
// CONFIGURAÇÕES
// =====================
const GOTENBERG_URL = process.env.GOTENBERG_URL;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "relatorios/";

const QUEUE_CONNECTION = process.env.PDF_QUEUE_CONNECTION || "PDF_QUEUE_STORAGE";
const RESULTS_QUEUE_NAME = process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results";
const RESULTS_CONN_STR = process.env.PDF_RESULTS_CONNECTION_STRING || process.env[QUEUE_CONNECTION];
const JOBS_QUEUE_NAME = process.env.PDF_QUEUE_NAME || "pdf-generation-jobs";

// =====================
// HELPERS
// =====================

function log(context, message) {
    if (context && typeof context.log === "function") return context.log(message);
    console.log(message);
}

function normalizeList(arrOrNull) {
    if (!arrOrNull) return [];
    const out = [];
    const pushSplit = (value) => {
        if (value == null) return;
        const str = String(value).trim();
        if (!str || str === "[object Object]") return;
        str.split(";").map(p => p.trim()).filter(p => p.length > 0).forEach(p => out.push(p));
    };
    if (typeof arrOrNull === "string") pushSplit(arrOrNull);
    else if (Array.isArray(arrOrNull)) {
        for (const item of arrOrNull) {
            if (typeof item === "string") pushSplit(item);
            else if (item && typeof item === "object") {
                pushSplit(item.Value ?? item.Result ?? item.Name ?? item.Label ?? "");
            }
        }
    }
    return out;
}

async function fetchAndOptimizePhoto(url, i, context) {
    try {
        const r = await axios.get(url, { responseType: "arraybuffer", timeout: 25000 });
        if (!r.data) return null;
        
        const outBuf = await sharp(Buffer.from(r.data))
            .rotate()
            .resize({ width: 1200, withoutEnlargement: true })
            .jpeg({ quality: 65, mozjpeg: true })
            .toBuffer();

        const filename = `img_${String(i + 1).padStart(2, "0")}.jpg`;
        return { filename, buffer: outBuf };
    } catch (e) {
        log(context, `[IMG ERR] Falha na foto ${i + 1}: ${e.message}`);
        return null;
    }
}

// =====================
// HANDLER
// =====================

app.storageQueue("GeneratePdfFromQueue", {
    queueName: JOBS_QUEUE_NAME,
    connection: QUEUE_CONNECTION,

    handler: async (queueItem, context) => {
        const rawPayload = typeof queueItem === "string" ? JSON.parse(queueItem) : queueItem;
        const data = rawPayload?.data ?? rawPayload ?? {};

        const templateBase = data.templateName || "Preventiva"; 
        const reportId = data.reportId || data.header?.reportNumber || `DOC_${Date.now()}`;
        
        log(context, `[START] Processando ${templateBase} ID: ${reportId}`);

        try {
            // 1. Processar Fotos (Comum a ambos)
            const photoAssets = [];
            const localPhotoNames = [];
            const rawFotos = normalizeList(data.fotos);
            
            for (let i = 0; i < rawFotos.length; i++) {
                const photo = await fetchAndOptimizePhoto(rawFotos[i], i, context);
                if (photo) {
                    photoAssets.push(photo);
                    localPhotoNames.push(photo.filename); 
                }
            }

            // 2. Construção do ViewModel Específico por Template
            let viewModel = {
                reportId: String(reportId),
                header: data.header || {},
                cliente: data.cliente || {},
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0
            };

            if (templateBase === "Orcamento") {
                // Estrutura para Orçamentos
                viewModel.produtos = data.produtos || []; 
                viewModel.resumo = data.resumo || {};
                viewModel.notas = data.notas || "";
            } else {
                // Estrutura padrão (Preventiva)
                viewModel.relatorio = data.relatorio || {};
                viewModel.maoObra = normalizeList(data.maoObra);
                viewModel.material = normalizeList(data.material);
            }

            // 3. Renderizar HTML
            const templatePath = path.join(__dirname, `${templateBase}.html`);
            if (!fs.existsSync(templatePath)) throw new Error(`Template ${templateBase}.html não encontrado.`);
            
            const htmlTemplate = fs.readFileSync(templatePath, "utf8");
            const renderedHtml = mustache.render(htmlTemplate, viewModel);

            // 4. Azure Blob Storage (Instanciar Clientes)
            const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            await containerClient.createIfNotExists();

            // 5. UPLOAD DE DEBUG (HTML) - Essencial para testar Orçamentos
            const debugBlobName = `${BLOB_PREFIX}debug_${reportId}.html`.replace(/\/{2,}/g, "/");
            const debugBlobClient = containerClient.getBlockBlobClient(debugBlobName);
            await debugBlobClient.uploadData(Buffer.from(renderedHtml, "utf8"), {
                blobHTTPHeaders: { blobContentType: "text/html" }
            });

            // 6. Gotenberg
            const form = new FormData();
            form.append("files", Buffer.from(renderedHtml, "utf8"), { filename: "index.html", contentType: "text/html" });
            for (const asset of photoAssets) {
                form.append("files", asset.buffer, { filename: asset.filename, contentType: "image/jpeg" });
            }
            form.append("pdfFormat", "PDF/A-1b");

            const response = await axios.post(GOTENBERG_URL, form, {
                responseType: "arraybuffer",
                headers: form.getHeaders(),
                timeout: 120000
            });

            // 7. Upload PDF
            const pdfBlobName = `${BLOB_PREFIX}${reportId}.pdf`.replace(/\/{2,}/g, "/");
            const blockBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
            await blockBlobClient.uploadData(Buffer.from(response.data), {
                blobHTTPHeaders: { blobContentType: "application/pdf" }
            });

            // 8. Resultado
            const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
            const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
            await qc.createIfNotExists();
            await qc.sendMessage(Buffer.from(JSON.stringify({
                status: "SUCCEEDED",
                reportId,
                pdfUrl: blockBlobClient.url,
                debugUrl: debugBlobClient.url, // Link do HTML para debug rápido
                dataverse: data.dataverse
            })).toString("base64"));

        } catch (err) {
            log(context, `[ERROR] ${err.message}`);
            throw err;
        }
    }
});
