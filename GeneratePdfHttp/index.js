// Worker File: GeneratePdfHttp/index.js (Lógica principal adaptada)

const axios = require('axios');
const mustache = require('mustache');
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

// Carregar o template
const templatePath = path.join(__dirname, '..', 'Preventiva.html');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

// ** FUNÇÃO PRINCIPAL (HTTP TRIGGER) **
module.exports = async function (context, req) {
    
    // VARIÁVEIS DE AMBIENTE (SECRETS) 
    const GOTENBERG_URL = process.env.GOTENBERG_URL; 
    const AZURE_STORAGE_CONNECTION_STRING = process.env.AzureWebJobsStorage;
    const BLOB_CONTAINER_NAME = 'relatorios-pdf-finais'; 

    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
        context.res = {
            status: 500,
            body: "Variáveis de ambiente (GOTENBERG_URL ou AzureWebJobsStorage) não definidas."
        };
        return;
    }

    try {
        // 1. ANALISAR O JSON DO CORPO HTTP
        const payload = req.body; 
        if (!payload || !payload.reportId) {
            context.res = { status: 400, body: "Payload JSON inválido ou incompleto." };
            return;
        }

        const { reportId, data, logoUrl } = payload; 
        context.log(`[JOB ${reportId}] Iniciando a geração via HTTP...`);

        // 2. PREENCHER O TEMPLATE
        const viewData = { ...data, logoUrl: logoUrl };
        const finalHtml = mustache.render(templateHtml, viewData);

        // 3. CHAMAR GOTENBERG (HTTP POST com FormData)
        const formData = new FormData();
        formData.append('files', finalHtml, { filename: 'index.html' });
        // ... (o resto dos appends)
        
        const response = await axios.post(GOTENBERG_URL, formData, {
            responseType: 'arraybuffer',
            headers: { 'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}` }
        });

        const pdfBuffer = response.data;
        
        // 4. GUARDAR NO BLOB STORAGE
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
        
        await containerClient.createIfNotExists();

        const blobName = `${reportId}_HTTP_TEST_${new Date().toISOString().replace(/:/g, '-')}.pdf`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(pdfBuffer, pdfBuffer.length);
        
        // 5. RESPOSTA DE SUCESSO HTTP
        context.res = {
            status: 200,
            body: `Sucesso. PDF (${blobName}) criado e guardado em Blob Storage.`
        };
        
    } catch (error) {
        context.error(`[JOB Error] Erro de processamento:`, error.message);
        context.res = {
            status: 500,
            body: `Erro de processamento: ${error.message}`
        };
    }
};
