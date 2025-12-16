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

app.http("GeneratePdfHttp", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {

    if (!GOTENBERG_URL || !AZURE_STORAGE_CONNECTION_STRING) {
      return { status: 500, body: "Variáveis de ambiente não definidas." };
    }

    const { reportId, data, logoUrl } = await request.json();

    const templatePath = path.join(__dirname, "Preventiva.html");
    const htmlTemplate = fs.readFileSync(templatePath, "utf8");

    const renderedHtml = mustache.render(htmlTemplate, { reportId, logoUrl, ...data });

    const form = new FormData();
    form.append("files", Buffer.from(renderedHtml), {
      filename: "index.html",
      contentType: "text/html"
    });

    const gotenbergResponse = await axios.post(GOTENBERG_URL, form, {
      responseType: "arraybuffer",
      headers: form.getHeaders()
    });

    const pdfBuffer = Buffer.from(gotenbergResponse.data);

    const blobServiceClient =
      BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    await containerClient.createIfNotExists();

    const blobName = `relatorios/${reportId}.pdf`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(pdfBuffer, {
      blobHTTPHeaders: { blobContentType: "application/pdf" }
    });

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { url: blockBlobClient.url }
    };
  }
});
