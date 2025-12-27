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

// Helper para limpar listas do PowerApps/Dataverse (Evita o [object Object])
function normalizeList(arrOrNull) {
    if (!arrOrNull) return [];
    const out = [];
    const pushSplit = (value) => {
        if (value == null) return;
        const str = String(value).trim();
        if (!str || str === "[object Object]") return;
        const parts = str.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
        for (const p of parts) out.push(p);
    };

    if (typeof arrOrNull === "string") {
        pushSplit(arrOrNull);
        return out;
    }

    if (Array.isArray(arrOrNull)) {
        for (const item of arrOrNull) {
            if (typeof item === "string") {
                pushSplit(item);
            } else if (item && typeof item === "object") {
                const val = item.Value ?? item.Result ?? item.Name ?? item.Label ?? "";
                pushSplit(val);
            }
        }
    }
    return out;
}

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
            const rawFotoUrls = normalizeList(data.fotos);

            if (rawFotoUrls.length > 0) {
                for (let i = 0; i < rawFotoUrls.length; i++) {
                    try {
                        const r = await axios.get(rawFotoUrls[i].trim(), { responseType: "arraybuffer", timeout: 20000 });
                        const buf = await sharp(Buffer.from(r.data)).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
                        const filename = `img_${i}.jpg`;
                        photoAssets.push({ filename, buffer: buf });
                        localPhotoNames.push(filename);
                    } catch (e) { context.log(`Erro foto ${i}: ${e.message}`); }
                }
            }

            // 2. CONSTRUÇÃO DO VIEWMODEL BASE
            let viewModel = {
                ...data,
                reportId,
                fotos: localPhotoNames,
                temFotos: localPhotoNames.length > 0
            };

            // 3. LÓGICA ESPECÍFICA: ORÇAMENTOS (CORREÇÃO DOS DESCONTOS AQUI)
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
                    viewModel.produtos = data.produtos.map(g => {
                        let somaG = 0;
                        const itns = (g.itens || []).map(i => {
                            const t = parseFloat(i.total) || 0;
                            const d = parseFloat(i.desconto) || 0; // Captura o desconto individual
                            somaG += t;
                            return { 
                                ...i, 
                                preco: fmt(i.preco), 
                                total: fmt(t),
                                desconto: d > 0 ? fmt(d) : null // ADICIONADO: Agora o desconto vai para o template
                            };
                        });
                        return { ...g, itens: itns, totalDoGrupo: data.produtos.length > 1 ? fmt(somaG) : null };
                    });
                }
            }

            // 4. LÓGICA ESPECÍFICA: PREVENTIVAS / RELATÓRIOS
            if (templateName === "Preventiva") {
                viewModel.maoObra = normalizeList(data.maoObra || data.maoDeObra);
                viewModel.material = normalizeList(data.material || data.materiais);
                viewModel.cliente = data.cliente || {};
                viewModel.relatorio = data.relatorio || {};
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
            await qc.sendMessage(Buffer.from(JSON.stringify({ 
                status: "SUCCEEDED", 
                reportId, 
                pdfUrl: blockBlobClient.url, 
                dataverse: data.dataverse 
            })).toString("base64"));

        } catch (err) {
            context.log(`Erro fatal: ${err.message}`);
            throw err;
        }
    }
});
