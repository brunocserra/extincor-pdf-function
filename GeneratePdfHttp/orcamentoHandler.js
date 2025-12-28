"use strict";
const { fmt } = require("./sharedUtils");

/**
 * Handler para o template de Orçamento
 * @param {Object} viewModel - Objeto que será enviado para o template HTML
 * @param {Object} data - Payload bruto recebido do Power Apps
 */
module.exports = function(viewModel, data) {
    // 1. Processamento do Cabeçalho (Header) 
    const h = data.header || {};
    const totalLiq = parseFloat(h.totalLiquido) || 0;
    const totalFim = parseFloat(h.totalFinal) || 0;
    const descFin = parseFloat(h.descontoFinanceiroValor) || 0;
    
    // Cálculo do valor do IVA (Total Final - Total Líquido) 
    const vIva = Math.max(0, totalFim - totalLiq);

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

    // Esta lista será usada pela GeneratePdfHttp.js para fazer os downloads
    const listaParaDownload = [];

    // 2. Processamento dos Grupos e Produtos 
    if (data.produtos && Array.isArray(data.produtos)) {
        viewModel.produtos = data.produtos.map(g => {
            let somaGrupo = 0;

            const itensProcessados = (g.itens || []).map(i => {
                const qtd = parseFloat(i.qty) || 0;
                const precoUnit = parseFloat(i.preco) || 0;
                const totalLinha = parseFloat(i.total) || 0;
                const descLinha = parseFloat(i.desconto) || 0;

                somaGrupo += totalLinha;

                // Lógica de Imagem Local (img_0.jpg, img_1.jpg...)
                let nomeLocalFoto = null;
                const idOriginal = i.prod_id ? String(i.prod_id).trim() : "";
                
                if (idOriginal !== "" && idOriginal !== "0") {
                    // Criamos o URL absoluto para a Function descarregar
                    const urlAzure = `https://extincorpdfsstore.blob.core.windows.net/produtos/${idOriginal}.jpg`;
                    
                    // Guardamos o URL na lista e usamos o índice atual para o nome
                    const index = listaParaDownload.length;
                    listaParaDownload.push(urlAzure);
                    
                    // O HTML vai referenciar a imagem que a Function vai guardar localmente
                    nomeLocalFoto = `img_${index}.jpg`;
                }

                return { 
                    ...i, 
                    qty: qtd,
                    preco: fmt(precoUnit), 
                    total: fmt(totalLinha), 
                    desconto: descLinha > 0 ? fmt(descLinha) : null,
                    fotoUrl: nomeLocalFoto // <--- O HTML usa o nome local (img_X.jpg)
                };
            });

            return { 
                ...g, 
                itens: itensProcessados, 
                totalDoGrupo: data.produtos.length > 1 ? fmt(somaGrupo) : null 
            };
        });
    } else {
        viewModel.produtos = [];
    }

    // 3. Exportar a lista de URLs para a Function Principal processar
    // Importante: No GeneratePdfHttp.js, deves ler esta variável: viewModel.listaDownloadsDinamica
    viewModel.listaDownloadsDinamica = listaParaDownload;

    viewModel.cliente = data.cliente || {};
    viewModel.reportId = data.reportId || "S/N";

    return viewModel;
};
