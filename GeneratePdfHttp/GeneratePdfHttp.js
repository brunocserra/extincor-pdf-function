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
            // --- 1. PREPARAÇÃO DO VIEWMODEL (CHAMADA DOS HANDLERS PRIMEIRO) ---
            let viewModel = {
                ...data,
                reportId,
                fotos: [], // Será preenchido abaixo
                temFotos: false
            };

            // Executa o handler específico para cada template
            // O OrcamentoHandler vai criar a lista 'listaDownloadsDinamica'
            if (templateName === "Orcamento") {
                viewModel = orcamentoHandler(viewModel, data);
            } else if (templateName === "Preventiva") {
                viewModel = preventivaHandler(viewModel, data);
            }

            // --- 2. PROCESSAMENTO DE IMAGENS ---
            const photoAssets = [];
            const localPhotoNames = [];
            
            // Decidimos quais URLs baixar:
            // Prioridade para a lista gerada dinamicamente pelo handler (Orcamento)
            // Caso contrário, usa a lista fixa enviada no payload (Preventiva)
            let urlsParaBaixar = [];
            if (viewModel.listaDownloadsDinamica && viewModel.listaDownloadsDinamica.length > 0) {
                urlsParaBaixar = viewModel.listaDownloadsDinamica;
            } else {
                urlsParaBaixar = utils.normalizeList(data.fotos);
            }

            for (let i = 0; i < urlsParaBaixar.length; i++) {
                try {
                    const url = urlsParaBaixar[i].trim();
                    const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
                    
                    const buf = await sharp(Buffer.from(r.data))
                        .rotate()
                        .resize({ width: 1200, withoutEnlargement: true })
                        .jpeg({ quality: 70 })
                        .toBuffer();
                    
                    const filename = `img_${i}.jpg`;
                    photoAssets.push({ filename, buffer: buf });
                    localPhotoNames.push(filename);
                } catch (e) { 
                    context.log(`Erro ao baixar foto ${i} (${urlsParaBaixar[i]}): ${e.message}`); 
                }
            }

            // Atualizamos o viewModel com os nomes das imagens locais (img_0.jpg, etc)
            // No Orçamento, o handler já associou cada item ao seu nome img_X, mas aqui garantimos o estado global
            viewModel.fotos = localPhotoNames;
            viewModel.temFotos = localPhotoNames.length > 0;

            // --- 3. RENDERIZAÇÃO HTML ---
            const templatePath = path.join(__dirname, `${templateName}.html`);
            const html = mustache.render(fs.readFileSync(templatePath, "utf8"), viewModel);

            // --- 4. CHAMADA AO GOTENBERG ---
            const form = new FormData();
            form.append("files", Buffer.from(html, "utf8"), { filename: "index.html", contentType: "text/html" });
            
            // Anexamos cada buffer de imagem como um arquivo local para o Gotenberg
            photoAssets.forEach(a => {
                form.append("files", a.buffer, { filename: a.filename, contentType: "image/jpeg" });
            });

            const res = await axios.post(process.env.GOTENBERG_URL, form, { 
                responseType: "arraybuffer", 
                headers: form.getHeaders(),
                timeout: 120000 
            });

            // --- 5. UPLOAD PARA AZURE BLOB ---
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const containerName = process.env.PDF_BLOB_CONTAINER || "pdf-reports";
            const containerClient = blobServiceClient.getContainerClient(containerName);
            const pdfBlobName = `${dynamicPrefix}${reportId}.pdf`.replace(/\/{2,}/g, "/").replace(/^\\//, "");
            const blockBlobClient = containerClient.getBlockBlobClient(pdfBlobName);
            await blockBlobClient.uploadData(Buffer.from(res.data), { blobHTTPHeaders: { blobContentType: "application/pdf" } });

            // --- 6. RESULTADO PARA FILA ---
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
