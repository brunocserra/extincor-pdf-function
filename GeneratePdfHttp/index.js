// GeneratePdfHttp/index.js  (Azure Functions Node v4 programming model)

const { app } = require("@azure/functions");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const { BlobServiceClient } = require("@azure/storage-blob");
const FormData = require("form-data");

const GOTENBERG_URL = process.env.GOTENBERG_URL;
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = "pdf-reports";

function logInfo(context, msg) {
  context.log(msg);
}
function logError(context, msg) {
  context.log(`ERRO: ${msg}`);
}

function jsonResponse(status, obj) {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

app.http("GeneratePdfHttp", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    logInfo(context, `HTTP trigger: ${request.url}`);

    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      logError(context, "Variáveis de ambiente em falta (GOTENBERG_URL / AZURE_STORAGE_CONNECTION_STRING).");
      return jsonResponse(500, {
        error: "Variáveis de ambiente críticas não definidas.",
        missing: {
          GOTENBERG_URL: !GOTENBERG_URL,
          AZURE_STORAGE_CONNECTION_STRING: !AZURE_STORAGE_CONNECTION_STRING
        }
      });
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse(400, { error: "Body inválido: não é JSON válido." });
      }

      const { reportId, data, logoUrl } = body || {};
      if (!reportId || !data) {
        return jsonResponse(400, { error: "Por favor, passe 'reportId' e 'data' no corpo do pedido." });
      }

      // Template HTML
      const templatePath = path.join(__dirname, "Preventiva.html");
      if (!fs.existsSync(templatePath)) {
        return jsonResponse(500, {
          error: "Template Preventiva.html não encontrado no deploy.",
          expectedPath: templatePath
        });
      }

      const htmlTemplate = fs.readFileSync(templatePath, "utf8");
      const renderedHtml = mustache.render(htmlTemplate, { reportId, logoUrl, ...data });

      // HTML -> PDF (Gotenberg)
      const form = new FormData();
      form.append("files", Buffer.from(renderedHtml, "utf8"), {
        filename: "index.html",
        contentType: "text/html"
      });

      logInfo(context, `A enviar HTML para o Gotenberg: ${GOTENBERG_URL}`);

      const gotenbergResponse = await axios.post(GOTENBERG_URL, form, {
        responseType: "arraybuffer",
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000
      });

      const pdfBuffer = Buffer.from(gotenbergResponse.data);
      const blobName = `relatorios/${reportId}.pdf`;

      // Upload Blob
      const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      await containerClient.createIfNotExists();

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: { blobContentType: "application/pdf" }
      });

      return jsonResponse(200, {
        message: `PDF ${reportId} gerado e guardado com sucesso.`,
        url: blockBlobClient.url
      });
    } catch (error) {
      logError(context, `Erro no processamento: ${error.message}`);

      let errorMessage = `Erro desconhecido: ${error.message}`;

      if (error.response?.status) {
        const status = error.response.status;

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
        errorMessage = "Timeout ao chamar o Gotenberg. Aumente o timeout ou otimize o HTML/imagens.";
      }

      return jsonResponse(500, { error: errorMessage });
    }
  }
});
