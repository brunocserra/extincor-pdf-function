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

// Helper de Formatação PT-PT
const fmt = (val) => {
    const num = parseFloat(val) || 0;
    return num.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

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
            // 1. PROCESSAMENTO DE IMAGENS
            const photoAssets = [];
            const localPhotoNames = [];
            if (data.fotos) {
                const rawFotos = Array.isArray(data.fotos) ? data.fotos : String(data.fotos).split(";").filter(f => f.trim());
                for (let i = 0; i < rawFotos.length; i++) {
                    try {
                        const r = await axios.get(rawFotos[i].trim(), { responseType: "arraybuffer", timeout: 20000 });
                        const buf = await sharp(Buffer.from(r.data)).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
                        const filename = `img_${i}.jpg`;
                        photoAssets.push({ filename, buffer: buf });
                        localPhotoNames.push(filename);
                    } catch (e) { context.log(`Erro foto ${i}`); }
                }
            }

            // 2. CONSTRUÇÃO DO VIEWMODEL BASE
            let viewModel = {
                ...data,
                reportId,
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0
            };

            // 3. LÓGICA ESPECÍFICA: ORÇAMENTOS (VALORES MONETÁRIOS E DESCONTOS)
            if (templateName === "Orcamento" || data.produtos) {
                const h = data.header || {};
                const totalLiq = parseFloat(h.totalLiquido) || 0;
                const totalFim = parseFloat(h.totalFinal) || 0;
                const descFin = parseFloat(h.descontoFinanceiroValor) || 0;
                const vIva = Math.max(0, totalFim - totalLiq + descFin);

                viewModel.header = {
                    ...h,
                    totalBruto: fmt(h.totalBruto),
                    totalDescontosItens: fmt(h.totalDescontosItens),
                    descontoFinanceiro: descFin > 0 ? fmt(descFin) : null,
                    totalLiquido: fmt(totalLiq),
                    valorIva: fmt(vIva),
                    totalFinal: fmt(totalFim),
                    taxaIva: h.taxaIva ? parseFloat(h.taxaIva).toFixed(0) : "0"
                };

                if (Array.isArray(data.produtos)) {
                    const multiGrupo = data.produtos.length > 1;
                    viewModel.produtos = data.produtos.map(g => {
                        let somaG = 0;
                        const itns = (g.itens || []).map(i => {
                            const t = parseFloat(i.total) || 0;
                            somaG += t;
                            return { 
                                ...i, 
                                preco: fmt(i.preco), 
                                desconto: parseFloat(i.desconto) > 0 ? fmt(i.desconto) : null,
                                total: fmt(t) 
                            };
                        });
                        return { ...g, itens: itns, totalDoGrupo: multiGrupo ? fmt(somaG) : null };
                    });
                }
            }

            // 4. LÓGICA ESPECÍFICA: PREVENTIVAS (MATERIAIS E MÃO DE OBRA)
            if (templateName === "Preventiva") {
                // Formatação simples para checklists ou materiais se houver preços envolvidos
                if (data.maoDeObra) {
                    viewModel.maoDeObra = data.maoDeObra.map(m => ({
                        ...m,
                        valor: m.valor ? fmt(m.valor) : null
                    }));
                }
                // Materiais costumam ser apenas listagem de QTD e Nome
                if (data.materiais) {
                    viewModel.materiais = data.materiais;
                }
            }

            // 5. RENDERIZAÇÃO E GERAÇÃO DO PDF
            const templatePath = path.join(__dirname, `${templateName}.html`);
            const html = mustache.render(fs.readFileSync(templatePath, "utf8"), viewModel);

            const form = new FormData();
            form.append("files", Buffer.from(html, "utf8"), { filename: "index.html", contentType: "text/html" });
            photoAssets.forEach(a => form.append("files", a.buffer, { filename: a.filename, contentType: "image/jpeg" }));

            const res = await axios.post(process.env.GOTENBERG_URL, form, { 
                responseType: "arraybuffer", 
                headers: form.getHeaders(),
                timeout: 120000 
            });

            // 6. STORAGE E CALLBACK
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(process.env.PDF_BLOB_CONTAINER || "pdf-reports");
            const pdfPath = `${dynamicPrefix}${reportId}.pdf`.replace(/^\//, "");
            const blockBlobClient = containerClient.getBlockBlobClient(pdfPath);
            await blockBlobClient.uploadData(Buffer.from(res.data), { blobHTTPHeaders: { blobContentType: "application/pdf" } });

            const qsc = QueueServiceClient.fromConnectionString(process.env.PDF_RESULTS_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING);
            const qc = qsc.getQueueClient(process.env.PDF_RESULTS_QUEUE_NAME || "pdf-results");
            await qc.sendMessage(Buffer.from(JSON.stringify({ status: "SUCCEEDED", reportId, pdfUrl: blockBlobClient.url, dataverse: data.dataverse })).toString("base64"));

        } catch (err) {
            context.log(`Erro: ${err.message}`);
            throw err;
        }
    }
});
