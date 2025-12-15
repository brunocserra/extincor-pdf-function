const path = require("path");
const fs = require("fs");

// 1) Define o path ANTES de carregar o Playwright
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.cwd(), ".pw-browsers");

const { chromium } = require("playwright");
const Handlebars = require("handlebars");

module.exports = async function (context, req) {
  try {
    // Debug rápido (para confirmares no log que a pasta existe no Azure)
    const pwPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    context.log("PLAYWRIGHT_BROWSERS_PATH =", pwPath);
    context.log("pw-browsers exists? =", fs.existsSync(pwPath));

    const { templateHtml, data } = req.body || {};
    if (!templateHtml || !data) {
      context.res = { status: 400, body: "Missing templateHtml or data" };
      return;
    }

    const template = Handlebars.compile(templateHtml);
    const html = template(data);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", bottom: "15mm", left: "15mm", right: "15mm" }
    });

    await browser.close();

    context.res = {
      status: 200,
      isRaw: true,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="relatorio.pdf"',
        "Cache-Control": "no-store"
      },
      body: pdfBuffer
    };
  } catch (err) {
    context.log.error(err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: err.stack || err.message || String(err)
    };
  }
};
