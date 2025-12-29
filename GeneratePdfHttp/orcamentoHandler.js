"use strict";
const { fmt } = require("./sharedUtils");

module.exports = function(viewModel, data) {
    // 1. Processamento do Cabeçalho (Header) 
    const h = data.header || {};
    
    // Valores Base vindos do Power Apps
    const totalBrutoItens = parseFloat(h.totalBruto) || 0;
    const totalDescontosLinhas = parseFloat(h.totalDescontosItens) || 0; 
    const percDescFinanceiro = parseFloat(h.descontoFinanceiroValor) || 0; 
    const taxaIva = (parseFloat(h.taxaIva) || 0) / 100;

    // Lógica de Totais Consolidada
    const baseAposDescontosLinhas = totalBrutoItens - totalDescontosLinhas;
    const valorDescFin = baseAposDescontosLinhas * (percDescFinanceiro / 100);
    
    const totalLiq = baseAposDescontosLinhas - valorDescFin;
    const vIva = totalLiq * taxaIva;
    const totalFim = totalLiq + vIva;
    
    // CALCULO DO DESCONTO TOTAL (Linhas + Financeiro)
    const totalDescontosSomado = (totalBrutoItens - totalLiq);
    const temDescontos = totalDescontosSomado > 0.01;

    viewModel.header = {
        ...h, 
        totalBruto: fmt(totalBrutoItens),
        temDescontos: temDescontos,
        // Envia o total de todos os descontos somados para a linha única do HTML
        totalDescontosGeral: fmt(totalDescontosSomado), 
        totalLiquido: fmt(totalLiq),
        valorIva: fmt(vIva),
        totalFinal: fmt(totalFim),
        taxaIva: (taxaIva * 100).toFixed(0),
        variosGrupos: h.variosGrupos 
    };

    // 2. Processamento dos Grupos e Produtos 
    const listaParaDownload = [];
    if (data.produtos && Array.isArray(data.produtos)) {
        viewModel.produtos = data.produtos
            .filter(g => g && (g.nomeGrupo || (g.itens && g.itens.length > 0)))
            .map(g => {
                let somaGrupoLiquida = 0;
                
                const itensProcessados = (g.itens || []).map(i => {
                    const totalLinha = parseFloat(i.total) || 0;
                    somaGrupoLiquida += totalLinha;

                    let nomeLocalFoto = null;
                    const idOriginal = i.prod_id ? String(i.prod_id).trim() : "";
                    if (idOriginal !== "" && idOriginal !== "0") {
                        const urlAzure = `https://extincorpdfsstore.blob.core.windows.net/produtos/${idOriginal}.jpg`;
                        const index = listaParaDownload.length;
                        listaParaDownload.push(urlAzure);
                        nomeLocalFoto = `img_${index}.jpg`;
                    }

                    return { 
                        ...i, 
                        qty: parseFloat(i.qty) || 0,
                        preco: fmt(parseFloat(i.preco) || 0),
                        total: fmt(totalLinha),
                        desconto: parseFloat(i.desconto) > 0 ? `${parseFloat(i.desconto)}%` : null,
                        fotoUrl: nomeLocalFoto
                    };
                });

                const fatorDescFin = (1 - (percDescFinanceiro / 100));
                const somaGrupoComIva = (somaGrupoLiquida * fatorDescFin) * (1 + taxaIva);

                return { 
                    ...g, 
                    itens: itensProcessados, 
                    totalDoGrupo: viewModel.header.variosGrupos ? fmt(somaGrupoComIva) : null 
                };
            });
    } else {
        viewModel.produtos = [];
    }

    viewModel.listaDownloadsDinamica = listaParaDownload;
    viewModel.cliente = data.cliente || {};
    viewModel.reportId = data.reportId || "S/N";

    return viewModel;
};
