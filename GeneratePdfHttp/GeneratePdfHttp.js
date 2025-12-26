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
const BLOB_PREFIX = process.env.PDF_BLOB_PREFIX || "";

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

async function sendResultMessage(resultObj, context) {
    if (!RESULTS_CONN_STR) return;
    try {
        const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
        const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
        await qc.createIfNotExists();
        const messageText = JSON.stringify(resultObj);
        await qc.sendMessage(Buffer.from(messageText).toString("base64"));
    } catch (err) {
        log(context, `[QUEUE ERROR] Erro ao enviar resultado: ${err?.message}`);
    }
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
    else if (Array.isArray(arrOrNull)) arrOrNull.forEach(item => {
        if (typeof item === "string") pushSplit(item);
        else if (item && typeof item === "object") pushSplit(item.Value ?? item.Result ?? item.Name ?? "");
    });
    return out;
}

function safeJsonParse(input, context) {
    try { return typeof input === "string" ? JSON.parse(input) : input; }
    catch (e) { log(context, `[JSON ERROR] ${e?.message}`); throw e; }
}

async function optimizePhoto(url, i, context) {
    try {
        const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
        if (!r.data) return null;
        const outBuf = await sharp(Buffer.from(r.data))
            .rotate()
            .resize({ width: 1200, withoutEnlargement: true })
            .jpeg({ quality: 70, mozjpeg: true })
            .toBuffer();
        return { filename: `img_${String(i).padStart(2, "0")}.jpg`, buffer: outBuf };
    } catch (e) {
        log(context, `[IMG ERR] Falha na foto ${i}: ${e.message}`);
        return null;
    }
}

// =====================
// HANDLER PRINCIPAL
// =====================

app.storageQueue("GeneratePdfFromQueue", {
    queueName: JOBS_QUEUE_NAME,
    connection: QUEUE_CONNECTION,

    handler: async (queueItem, context) => {
        const payload = safeJsonParse(queueItem, context);
        const data = payload?.data ?? payload ?? {};

        // Identificação do Documento
        const templateBase = data.templateName || "Preventiva"; 
        const templateFile = `${templateBase}.html`;
        const reportId = data.reportId || data.header?.reportNumber || `DOC_${Date.now()}`;
        const subFolder = data.subFolder || `${templateBase.toLowerCase()}s/`;

        log(context, `[EXE] Template: ${templateFile} | ID: ${reportId}`);

        try {
            if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) throw new Error("Missing Env Vars");

            // 1. Validar existência do template
            const templatePath = path.join(__dirname, templateFile);
            if (!fs.existsSync(templatePath)) throw new Error(`Template ${templateFile} não encontrado.`);

            // 2. Processar Fotos (apenas se existirem no payload)
            const photoAssets = [];
            const localPhotoNames = [];
            const rawFotos = data.fotos || [];
            
            for (let i = 0; i < rawFotos.length; i++) {
                const photo = await optimizePhoto(rawFotos[i], i, context);
                if (photo) {
                    photoAssets.push(photo);
                    localPhotoNames.push(photo.filename);
                }
            }

            // 3. PROCESSAMENTO DE JSON POR TEMPLATE (Business Logic)
            let viewModel = {};

            switch (templateBase) {
                case "Orcamento":
                    viewModel = {
                        reportId: reportId,
                        header: data.header || {},
                        cliente: data.cliente || {},
                        produtos: data.produtos || [], // Estrutura de Grupos
                        resumo: data.resumo || {},
                        notas: data.notas || "",
                        fotos: localPhotoNames,
                        temFotos: localPhotoNames.length > 0
                    };
                    break;

                case "Preventiva":
                    viewModel = {
                        reportId: reportId,
                        header: data.header || {},
                        cliente: data.cliente || {},
                        relatorio: data.relatorio || {},
                        maoObra: normalizeList(data.maoObra),
                        material: normalizeList(data.material),
                        fotos: localPhotoNames,
                        temFotos: localPhotoNames.length > 0
                    };
                    break;

                default:
                    // Se for um novo template ainda não mapeado, passa o objeto bruto
                    viewModel = { 
                        ...data, 
                        reportId, 
                        fotos: localPhotoNames, 
                        temFotos: localPhotoNames.length > 0 
                    };
            }

            // 4. Renderização com Mustache
            const htmlTemplate = fs.readFileSync(templatePath, "utf8");
            const renderedHtml = mustache.render(htmlTemplate, viewModel);

            // 5. Comunicação com Gotenberg
            const form = new FormData();
            form.append("files", Buffer.from(renderedHtml, "utf8"), { filename: "index.html", contentType: "text/html" });
            photoAssets.forEach(a => {
                form.append("files", a.buffer, { filename: a.filename, contentType: "image/jpeg" });
            });
            form.append("pdfFormat", "PDF/A-1b");

            const response = await axios.post(GOTENBERG_URL, form, {
                responseType: "arraybuffer",
                headers: form.getHeaders(),
                timeout: 120000
            });

            // 6. Upload para Azure Blob Storage
            const blobName = `${BLOB_PREFIX}${subFolder}${reportId}.pdf`.replace(/\/{2,}/g, "/");
            const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            await containerClient.createIfNotExists();

            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            await blockBlobClient.uploadData(Buffer.from(response.data), {
                blobHTTPHeaders: { blobContentType: "application/pdf" }
            });

            // 7. Resposta para a Queue de Resultados (Callback)
            await sendResultMessage({
                status: "SUCCEEDED",
                templateUsed: templateBase,
                reportId: reportId,
                pdfUrl: blockBlobClient.url,
                blobName: blobName,
                dataverse: data.dataverse // Metadados para o Power Automate
            }, context);

            log(context, `[OK] PDF ${reportId} gerado em ${subFolder}`);

        } catch (err) {
            log(context, `[ERROR] ${err.message}`);
            await sendResultMessage({ status: "FAILED", error: err.message, reportId }, context);
            throw err;
        }
    }
});
