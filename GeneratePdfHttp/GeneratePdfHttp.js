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
const BASE_PREFIX = process.env.PDF_BLOB_PREFIX || ""; 

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
        const r = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
        if (!r.data) return null;
        const outBuf = await sharp(Buffer.from(r.data))
            .rotate()
            .resize({ width: 1200, withoutEnlargement: true })
            .jpeg({ quality: 70, mozjpeg: true })
            .toBuffer();
        return { filename: `img_${String(i + 1).padStart(2, "0")}.jpg`, buffer: outBuf };
    } catch (e) {
        log(context, `[IMG ERR] Falha na foto ${i + 1}: ${e.message}`);
        return null;
    }
}

// =====================
// HANDLER GENÉRICO
// =====================

app.storageQueue("GeneratePdfFromQueue", {
    queueName: JOBS_QUEUE_NAME,
    connection: QUEUE_CONNECTION,

    handler: async (queueItem, context) => {
        const rawPayload = typeof queueItem === "string" ? JSON.parse(queueItem) : queueItem;
        const data = rawPayload?.data ?? rawPayload ?? {};

        // 1. MAPEAMENTO GENÉRICO (Lê tudo do payload)
        const templateName = data.templateName || "Preventiva"; 
        const reportId = data.reportId || data.header?.reportNumber || `DOC_${Date.now()}`;
        const subFolder = data.subFolder || ""; // Se vazio, salva na raiz do container
        
        // Garante que o caminho termina com barra e não tem barras duplas
        const dynamicPrefix = `${BASE_PREFIX}${subFolder}`.replace(/\/{2,}/g, "/");

        log(context, `[EXE] Template: ${templateName} | Pasta: ${dynamicPrefix} | ID: ${reportId}`);

        try {
            // 2. PROCESSAMENTO DE FOTOS
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

            // 3. VIEWMODEL GENÉRICO
            // Passamos o objeto 'data' inteiro para que qualquer campo novo no JSON 
            // seja acessível no Mustache automaticamente, além dos campos padronizados.
            const viewModel = {
                ...data, // Espalha tudo (cliente, header, produtos, relatorio, etc.)
                reportId,
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0,
                // Garantimos normalização de listas conhecidas para evitar erros de template
                maoObra: normalizeList(data.maoObra),
                material: normalizeList(data.material)
            };

            // 4. RENDERIZAÇÃO
            const templatePath = path.join(__dirname, `${templateName}.html`);
            if (!fs.existsSync(templatePath)) throw new Error(`Arquivo ${templateName}.html não encontrado no servidor.`);
            const renderedHtml = mustache.render(fs.readFileSync(templatePath, "utf8"), viewModel);

            // 5. AZURE STORAGE (Clientes)
            const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            await containerClient.createIfNotExists();

            // 6. UPLOAD DEBUG (HTML)
            const debugBlobName = `${dynamicPrefix}debug_${reportId}.html`.replace(/^\//, "");
            const debugBlobClient = containerClient.getBlockBlobClient(debugBlobName);
            await debugBlobClient.uploadData(Buffer.from(renderedHtml, "utf8"), {
                blobHTTPHeaders: { blobContentType: "text/html" }
            });

            // 7. GOTENBERG (Conversão)
            const form = new FormData();
            form.append("files", Buffer.from(renderedHtml, "utf8"), { filename: "index.html", contentType: "text/html" });
            photoAssets.forEach(a => form.append("files", a.buffer, { filename: a.filename, contentType: "image/jpeg" }));
            form.append("pdfFormat", "PDF/A-1b");

            const response = await axios.post(GOTENBERG_URL, form, {
                responseType: "arraybuffer",
                headers: form.getHeaders(),
                timeout: 120000
            });

            // 8. UPLOAD PDF FINAL
            const pdfBlobName = `${dynamicPrefix}${reportId}.pdf`.replace(/^\//, "");
            const blockBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
            await blockBlobClient.uploadData(Buffer.from(response.data), {
                blobHTTPHeaders: { blobContentType: "application/pdf" }
            });

            // 9. CALLBACK DE RESULTADO
            const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
            const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
            await qc.createIfNotExists();
            await qc.sendMessage(Buffer.from(JSON.stringify({
                status: "SUCCEEDED",
                reportId,
                templateUsed: templateName,
                pdfUrl: blockBlobClient.url,
                debugUrl: debugBlobClient.url,
                blobPath: pdfBlobName,
                dataverse: data.dataverse
            })).toString("base64"));

            log(context, `[OK] Sucesso: ${pdfBlobName}`);

        } catch (err) {
            log(context, `[FATAL] ${err.message}`);
            // Envia falha para a fila para que o Power Automate saiba que parou
            try {
                const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
                const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
                await qc.sendMessage(Buffer.from(JSON.stringify({ status: "FAILED", reportId, error: err.message })).toString("base64"));
            } catch (e) {}
            throw err;
        }
    }
});
