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

// Função para formatar números para o padrão 1.234,56
const fmt = (val) => {
    const num = parseFloat(val) || 0;
    return num.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

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

        const templateName = data.templateName || "Preventiva"; 
        const reportId = data.reportId || data.header?.reportNumber || `DOC_${Date.now()}`;
        const subFolder = data.subFolder || ""; 
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

            // 3. VIEWMODEL COM TRATAMENTO DE VALORES E GRUPOS
            const viewModel = {
                ...data,
                reportId,
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0,
                header: data.header ? {
                    ...data.header,
                    totalLiquido: fmt(data.header.totalLiquido),
                    totalFinal: fmt(data.header.totalFinal),
                    valorIva: fmt((parseFloat(data.header.totalFinal) || 0) - (parseFloat(data.header.totalLiquido) || 0))
                } : {},
                maoObra: normalizeList(data.maoObra),
                material: normalizeList(data.material)
            };

            // Lógica de Produtos: Formatação e Totais de Secção
            if (data.produtos && Array.isArray(data.produtos)) {
                const multiGrupo = data.produtos.length > 1;
                viewModel.produtos = data.produtos.map(grupo => {
                    let somaSecao = 0;
                    const itensProcessados = (grupo.itens || []).map(item => {
                        somaSecao += (parseFloat(item.total) || 0);
                        return {
                            ...item,
                            preco: fmt(item.preco),
                            total: fmt(item.total)
                        };
                    });
                    return {
                        ...grupo,
                        itens: itensProcessados,
                        // Só envia totalDoGrupo se houver mais que um grupo no total
                        totalDoGrupo: multiGrupo ? fmt(somaSecao) : null
                    };
                });
            }

            // 4. RENDERIZAÇÃO
            const templatePath = path.join(__dirname, `${templateName}.html`);
            if (!fs.existsSync(templatePath)) throw new Error(`Arquivo ${templateName}.html não encontrado.`);
            const renderedHtml = mustache.render(fs.readFileSync(templatePath, "utf8"), viewModel);

            // 5. AZURE STORAGE
            const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
            await containerClient.createIfNotExists();

            // 6. UPLOAD DEBUG (HTML)
            const debugBlobName = `${dynamicPrefix}debug_${reportId}.html`.replace(/^\//, "");
            await containerClient.getBlockBlobClient(debugBlobName).uploadData(Buffer.from(renderedHtml, "utf8"), {
                blobHTTPHeaders: { blobContentType: "text/html" }
            });

            // 7. GOTENBERG
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

            // 9. CALLBACK
            const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
            const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
            await qc.createIfNotExists();
            await qc.sendMessage(Buffer.from(JSON.stringify({
                status: "SUCCEEDED",
                reportId,
                templateUsed: templateName,
                pdfUrl: blockBlobClient.url,
                blobPath: pdfBlobName,
                dataverse: data.dataverse
            })).toString("base64"));

            log(context, `[OK] Sucesso: ${pdfBlobName}`);

        } catch (err) {
            log(context, `[FATAL] ${err.message}`);
            try {
                const qsc = QueueServiceClient.fromConnectionString(RESULTS_CONN_STR);
                const qc = qsc.getQueueClient(RESULTS_QUEUE_NAME);
                await qc.sendMessage(Buffer.from(JSON.stringify({ status: "FAILED", reportId, error: err.message })).toString("base64"));
            } catch (e) {}
            throw err;
        }
    }
});
