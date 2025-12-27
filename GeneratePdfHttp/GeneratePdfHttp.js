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

// Importar os Handlers e Utils
const utils = require("./sharedUtils");
const orcamentoHandler = require("./orcamentoHandler");
const preventivaHandler = require("./preventivaHandler");

app.storageQueue("GeneratePdfFromQueue", {
    queueName: process.env.PDF_QUEUE_NAME || "pdf-generation-jobs",
    connection: "PDF_QUEUE_STORAGE",

    handler: async (queueItem, context) => {
        const rawPayload = typeof queueItem === "string" ? JSON.parse(queueItem) : queueItem;
        const data = rawPayload?.data ?? rawPayload ?? {};

        const templateName = data.templateName || "Orcamento"; 
        const reportId = data.reportId || `DOC_${Date.now()}`;
        const subFolder = data.subFolder || "";
        const dynamicPrefix = `${process.env.PDF_BLOB_PREFIX || ""}${subFolder}`.replace(/\/{2,}/g, "/");

        try {
            // 1. Processamento de Imagens (Comum)
            const photoAssets = [];
            const localPhotoNames = [];
            const rawFotoUrls = utils.normalizeList(data.fotos);

            for (let i = 0; i < rawFotoUrls.length; i++) {
                try {
                    const r = await axios.get(rawFotoUrls[i].trim(), { responseType: "arraybuffer", timeout: 20000 });
                    const buf = await sharp(Buffer.from(r.data)).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
                    const filename = `img_${i}.jpg`;
                    photoAssets.push({ filename, buffer: buf });
                    localPhotoNames.push(filename);
                } catch (e) { context.log(`Erro foto ${i}: ${e.message}`); }
            }

            // 2. Escolha da Lógica por Template
            let viewModel = {
                ...data,
                reportId,
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0
            };

            if (templateName === "Orcamento") {
                viewModel = orcamentoHandler(viewModel, data);
            } else if (templateName === "Preventiva") {
                viewModel = preventivaHandler(viewModel, data);
            }

            // 3. Renderização HTML
            const templatePath = path.join(__dirname, `${templateName}.html`);
            const html = mustache.render(fs.readFileSync(templatePath, "utf8"), viewModel);

            // 4. Chamada ao Gotenberg
            const form = new FormData();
            form.append("files", Buffer.from(html, "utf8"), { filename: "index.html", contentType: "text/html" });
            photoAssets.forEach(a => form.append("files", a.buffer, { filename: a.filename, contentType: "image/jpeg" }));

            const res = await axios.post(process.env.GOTENBERG_URL, form, { 
                responseType: "arraybuffer", 
                headers: form.getHeaders(),
                timeout: 120000 
            });

            // 5. Upload para Azure Blob
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const containerName = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
            const containerClient = blobServiceClient.getContainerClient(containerName);
            const pdfBlobName = `${dynamicPrefix}${reportId}.pdf`.replace(/\/{2,}/g, "/").replace(/^\//, "");
            const blockBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
            await blockBlobClient.uploadData(Buffer.from(res.data), { blobHTTPHeaders: { blobContentType: "application/pdf" } });

            // 6. Resultado para Fila
            const qsc = QueueServiceClient.fromConnectionString(process.env.PDF_RESULTS_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING);
            const qc = qsc.getQueueClient(process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results");
            
            const resultPayload = { 
                status: "SUCCEEDED", 
                reportId, 
                pdfUrl: blockBlobClient.url,
                blobName: pdfBlobName,
                containerName: containerName,
                dataverse: data.dataverse 
            };

            await qc.sendMessage(Buffer.from(JSON.stringify(resultPayload)).toString("base64"));

        } catch (err) {
            context.log(`Erro fatal: ${err.message}`);
            throw err;
        }
    }
});
