// GeneratePdfHttp/index.js  (Azure Functions Node v4 programming model)

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const FormData = require("form-data");

// Variáveis de ambiente
const GOTENBERG_URL = process.env.GOTENBERG_URL;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "pdf-reports";

// Helper simples para logs (compatível)
function logInfo(context, msg) {
  context.log(msg);
}
function logError(context, msg) {
  context.log(`ERRO: ${msg}`);
}

app.http("GeneratePdfHttp", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    logInfo(context, `HTTP trigger: ${request.url}`);

    // Guardrail: variáveis críticas
    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      logError(context, "Variáveis de ambiente em falta (GOTENBERG_URL / AZURE_STORAGE_CONNECTION_STRING).");
      return {
        status: 500,
        body: "Erro: variáveis de ambiente críticas não definidas."
      };
    }

    try {
      // Body
      const body = await request.json();
      const { reportId, data, logoUrl } = body || {};

      if (!reportId || !data) {
        return {
          status: 400,
          body: "Por favor, passe 'reportId' e 'data' no corpo do pedido."
        };
      }

      // 1) Gerar HTML a partir do template
      const templatePath = path.join(__dirname, "Preventiva.html");
      const htmlTemplate = fs.readFileSync(templatePath, "utf8");

      const renderedHtml = mustache.render(htmlTemplate, {
        reportId,
        logoUrl,
        ...data
      });

      // 2) Converter HTML -> PDF (Gotenberg)
      const form = new FormData();
      form.append("files", Buffer.from(renderedHtml, "utf8"), {
        filename: "index.html",
        contentType: "text/html"
      });

      logInfo(context, `A enviar HTML para o Gotenberg em: ${GOTENBERG_URL}`);

      const gotenbergResponse = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000 // 120s (ajusta se precisares)
      });

      const pdfBuffer = Buffer.from(gotenbergResponse.data);
      const blobName = `relatorios/${reportId}.pdf`;

      // 3) Upload para Azure Blob Storage
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        AZURE_STORAGE_CONNECTION_STRING
      );
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);

      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      logInfo(context, `A enviar PDF para Blob Storage: ${blobName}`);

      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" }
      });

      // 4) Resposta
      const pdfUrl = blockBlobClient.url;
      logInfo(context, `PDF guardado com sucesso em: ${pdfUrl}`);

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: {
          message: `PDF ${reportId} gerado e guardado com sucesso.`,
          url: pdfUrl
        }
      };
    } catch (error) {
      logError(context, `Erro no processamento: ${error.message}`);

      let errorMessage = `Erro desconhecido: ${error.message}`;

      // Erro HTTP (ex.: Gotenberg)
      if (error.response?.status) {
        const status = error.response.status;

        // Tentar extrair detalhe curto (evitar binários enormes)
        let details = "N/A";
        try {
          if (error.response.data) {
            const raw = Buffer.isBuffer(error.response.data)
              ? error.response.data.toString("utf8")
              : String(error.response.data);
            details = raw.slice(0, 2000);
          }
        } catch (_) {}

        errorMessage = `Erro Gotenberg: status ${status}. Detalhes: ${details}`;
      } else if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        errorMessage =
          "Erro de Conexão: incapaz de conectar ao Gotenberg. Verifique rede/VNet/Firewall e GOTENBERG_URL.";
      } else if (error.code === "ETIMEDOUT") {
        errorMessage =
          "Timeout ao chamar o Gotenberg. Aumente o timeout ou otimize o HTML/imagens.";
      }

      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: errorMessage }
      };
    }
  }
});
