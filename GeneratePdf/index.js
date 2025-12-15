const path = require("path");
const { chromium } = require("playwright");
const Handlebars = require("handlebars");

module.exports = async function (context, req) {
  try {
    // 1) Validar input
    const { templateHtml, data } = req.body || {};

    if (!templateHtml || !data) {
      context.res = {
        status: 400,
        body: "Missing templateHtml or data"
      };
      return;
    }

    // 2) Forçar Playwright a usar browsers empacotados
    // Em Azure Functions o cwd = C:\home\site\wwwroot
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.cwd(),
      ".pw-browsers"
    );

    // 3) Renderizar HTML com Handlebars
    const template = Handlebars.compile(templateHtml);
    const html = template(data);

    // 4) Lançar Chromium
    const browser = await chromium.launch({
      headless: true
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle"
    });

    // 5) Gerar PDF
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "15mm",
        bottom: "15mm",
        left: "15mm",
        right: "15mm"
      }
    });

    await browser.close();

    // 6) Resposta HTTP correta (PDF binário)
    context.res = {
      status: 200,
      isRaw: true,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=report.pdf"
      },
      body: pdfBuffer
    };
  } catch (err) {
    // Debug completo no response (temporário)
    context.log.error(err);

    context.res = {
      status: 500,
      headers: { "Content-Type": "text/plain" },
      body: err.stack || err.message || String(err)
    };
  }
};
