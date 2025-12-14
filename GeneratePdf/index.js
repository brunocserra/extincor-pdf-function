const { chromium } = require('playwright');
const Handlebars = require('handlebars');

module.exports = async function (context, req) {
  try {
    const { templateHtml, data, headerHtml, footerHtml } = req.body || {};

    if (!templateHtml) {
      context.res = {
        status: 400,
        body: "templateHtml em falta"
      };
      return;
    }

    // 1) Aplicar dados ao template HTML
    const html = Handlebars.compile(templateHtml)(data || {});

    // 2) Lançar Chromium
    const browser = await chromium.launch({
      args: ['--no-sandbox']
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: 'networkidle'
    });

    // 3) Gerar PDF real
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '15mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm'
      },
      displayHeaderFooter: Boolean(headerHtml || footerHtml),
      headerTemplate: headerHtml || '<div></div>',
      footerTemplate: footerHtml || '<div></div>'
    });

    await browser.close();

    // 4) Responder com PDF binário
    context.res = {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="relatorio.pdf"',
        'Cache-Control': 'no-store'
      },
      body: pdfBuffer,
      isRaw: true
    };

  } catch (err) {
    context.log.error(err);
    context.res = {
      status: 500,
      body: "Erro a gerar PDF"
    };
  }
};
