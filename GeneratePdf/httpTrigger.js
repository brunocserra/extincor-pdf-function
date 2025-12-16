// Worker File: GeneratePdf/index.js (Lógica principal)

// ** 1. DEPENDÊNCIAS (TODAS NO TOPO!) **
const axios = require('axios');
const mustache = require('mustache');
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data'); // <-- CORREÇÃO: MOVIDO PARA O TOPO

// ** 2. CARREGAR TEMPLATE HTML (UMA VEZ NA INICIALIZAÇÃO) **
// Obtém o template HTML que está no mesmo nível que o diretório da função
const templatePath = path.join(__dirname, '..', 'Preventiva.html');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

// ** 3. FUNÇÃO PRINCIPAL (QUEUE TRIGGER) **
// O Azure Function recebe a mensagem da fila (queueItem) e o contexto
module.exports = async function (context, queueItem) {
    
    // ** VARIÁVEIS DE AMBIENTE (SECRETS) **
    const GOTENBERG_URL = process.env.GOTENBERG_URL; 
    const AZURE_STORAGE_CONNECTION_STRING = process.env.AzureWebJobsStorage;
    const BLOB_CONTAINER_NAME = 'relatorios-pdf-finais'; 

    // Verificação essencial
    if (!GOTENBERG_URL) {
        context.error("GOTENBERG_URL não está definido nas variáveis de ambiente!");
        return;
    }

    try {
        // 1. ANALISAR O JSON
        const payload = JSON.parse(queueItem);
        const { reportId, data, logoUrl } = payload; 
        
        context.log(`[JOB ${reportId}] Iniciando a geração...`);

        // 2. PREENCHER O TEMPLATE
        const viewData = { ...data, logoUrl: logoUrl };
        const finalHtml = mustache.render(templateHtml, viewData);

        // 3. CHAMAR GOTENBERG (HTTP POST com FormData)
        // Usamos a classe FormData que foi carregada no topo do ficheiro
        const formData = new FormData();
        formData.append('files', finalHtml, { filename: 'index.html' });
        formData.append('printBackground', 'true');
        formData.append('scale', '0.9');

        const response = await axios.post(GOTENBERG_URL, formData, {
            responseType: 'arraybuffer',
            headers: { 'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}` }
        });

        const pdfBuffer = response.data;
        
        // 4. GUARDAR NO BLOB STORAGE
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
        
        // Certifica-se de que o container existe
        await containerClient.createIfNotExists();

        const blobName = `${reportId}_${new Date().toISOString().replace(/:/g, '-')}.pdf`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(pdfBuffer, pdfBuffer.length);
        context.log(`[JOB ${reportId}] Sucesso. URL: ${blockBlobClient.url}`);
        
    }  catch (error) {
        context.error(`[JOB Error] Erro de processamento:`, error.message);
        
        // ** DEEPER AXIOS DEBUG **
        if (error.response) {
            // O servidor Gotenberg respondeu com um status de erro (ex: 400, 500)
            context.error(`[AXIOS] Erro de Resposta (Status: ${error.response.status}):`, error.response.data.toString());
        } else if (error.request) {
            // O pedido foi feito, mas não houve resposta (timeout, rede)
            context.error(`[AXIOS] Erro de Rede/Timeout. Não houve resposta do Gotenberg.`);
        } else {
            // Algo mais na configuração do Axios falhou
            context.error(`[AXIOS] Erro de Configuração:`, error.message);
        }
        // ** FIM DO DEEPER AXIOS DEBUG **

        // Lança o erro para que o Azure Queue Storage tente novamente processar a mensagem
        throw error; 
    }
};


