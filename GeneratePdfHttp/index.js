const { app } = require('@azure/functions');
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // Adicionado o módulo 'path'
const mustache = require('mustache');
const { BlobServiceClient } = require('@azure/storage-blob');

// 1. Variáveis de Ambiente
const GOTENBERG_URL = process.env.GOTENBERG_URL;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = 'pdf-reports'; // Nome do seu container no Blob Storage

app.http('GeneratePdfHttp', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {

        context.log(`HTTP trigger function processed request for URL: ${request.url}`);

        // --- 2. GUARDRAIL PARA VARIÁVEIS DE AMBIENTE ---
        if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
            context.error("Variáveis de ambiente (GOTENBERG_URL ou AZURE_STORAGE_CONNECTION_STRING) não definidas.");
            return {
                status: 500,
                body: "Erro: Variáveis de ambiente críticas não definidas."
            };
        }

        try {
            const body = await request.json();
            const { reportId, data, logoUrl } = body;

            if (!reportId || !data) {
                return {
                    status: 400,
                    body: "Por favor, passe 'reportId' e 'data' no corpo do pedido."
                };
            }

            // --- 3. Geração do HTML ---

            // ** CORREÇÃO AQUI **
            // Usa path.join e __dirname para garantir o caminho correto.
            const templatePath = path.join(__dirname, 'Preventiva.html');
            const htmlTemplate = fs.readFileSync(templatePath, 'utf8');

            const renderedHtml = mustache.render(htmlTemplate, { 
                reportId, 
                logoUrl, 
                ...data 
            });

            // --- 4. Conversão para PDF (Chamada Gotenberg) ---
            const gotenbergData = new FormData();
            gotenbergData.append('files', new Blob([renderedHtml], { type: 'text/html' }), 'index.html');
            
            context.log(`A enviar HTML para o Gotenberg em: ${GOTENBERG_URL}`);
            
            const gotenbergResponse = await axios.post(GOTENBERG_URL, gotenbergData, {
                responseType: 'arraybuffer', // Recebe o PDF como um buffer binário
                headers: {
                    ...gotenbergData.getHeaders ? gotenbergData.getHeaders() : {},
                    'Content-Type': 'multipart/form-data'
                }
            });
            
            const pdfBuffer = gotenbergResponse.data;
            const blobName = `relatorios/${reportId}.pdf`;

            // --- 5. Upload para Azure Blob Storage ---

            const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

            // Tenta criar o container se não existir
            try {
                await containerClient.createIfNotExists();
            } catch (containerError) {
                context.error(`Erro ao criar container: ${containerError.message}`);
                throw new Error(`Erro de Container: ${containerError.message}`);
            }

            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            context.log(`A enviar PDF para Blob Storage: ${blobName}`);

            await blockBlobClient.uploadData(Buffer.from(pdfBuffer), {
                blobHTTPHeaders: { blobContentType: 'application/pdf' }
            });

            // --- 6. Resposta Final ---
            const pdfUrl = blockBlobClient.url;
            context.log(`PDF guardado com sucesso em: ${pdfUrl}`);

            return {
                status: 200,
                body: JSON.stringify({
                    message: `PDF ${reportId} gerado e guardado com sucesso.`,
                    url: pdfUrl
                }),
                headers: {
                    'Content-Type': 'application/json'
                }
            };

        } catch (error) {
            
            context.error(`Erro no processamento da função: ${error.message}`);
            
            // Tratamento de Erros Comuns de Conexão
            let errorMessage = `Erro desconhecido: ${error.message}`;

            if (error.response && error.response.status) {
                 // Erro HTTP do Gotenberg
                errorMessage = `Erro Gotenberg: Falha na conversão com o status ${error.response.status}. Detalhes: ${error.response.data ? error.response.data.toString() : 'N/A'}`;
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                // Erro de Firewall/Conexão
                errorMessage = `Erro de Conexão: Incapaz de conectar ao Gotenberg. Verifique a Firewall/VNet ou o GOTENBERG_URL.`;
            }

            return {
                status: 500,
                body: JSON.stringify({ error: errorMessage })
            };
        }
    }
});
