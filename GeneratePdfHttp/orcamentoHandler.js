"use strict";
const { fmt } = require("./sharedUtils");

module.exports = function(viewModel, data) {
    // 1. Processamento do Cabeçalho (Header) 
    const h = data.header || {};
    
    // Valores Base
    const totalBrutoItens = parseFloat(h.totalBruto) || 0;
    const totalDescontosLinhas = parseFloat(h.totalDescontosItens) || 0;
    const percDescFinanceiro = parseFloat(h.descontoFinanceiroValor) || 0;
    const taxaIva = (parseFloat(h.taxaIva) || 0) / 100;

    // Lógica de Totais
    const baseAposDescontosLinhas = totalBrutoItens - totalDescontosLinhas;
    const valorDescFin = baseAposDescontosLinhas * (percDescFinanceiro / 100);
    
    const totalLiq = baseAposDescontosLinhas - valorDescFin;
    const vIva = totalLiq * taxaIva;
    const totalFim = totalLiq + vIva;
    
    // Verificação se existem descontos para mudar o layout da caixa de totais
    const totalDescontosGeral = (totalBrutoItens - totalLiq);
    const temDescontos = totalDescontosGeral > 0.01;

    viewModel.header = {
        ...h, 
        totalBruto: fmt(totalBrutoItens),
        temDescontos: temDescontos,
        totalDescontosItens: totalDescontosGeral > 0 ? fmt(totalDescontosGeral) : null,
        labelDesconto: percDescFinanceiro > 0 ? `Desconto Financeiro (${percDescFinanceiro}%)` : "Desconto Financeiro",
        descontoFinanceiro: valorDescFin > 0 ? fmt(valorDescFin) : null,
        totalLiquido: fmt(totalLiq),
        valorIva: fmt(vIva),
        totalFinal: fmt(totalFim),
        taxaIva: (taxaIva * 100).toFixed(0)
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
                        desconto: parseFloat(i.desconto) > 0 ? fmt(parseFloat(i.desconto)) : null,
                        fotoUrl: nomeLocalFoto
                    };
                });

                // Total do Grupo com IVA e proporcional ao desconto financeiro
                const fatorDescFin = (1 - (percDescFinanceiro / 100));
                const somaGrupoComIva = (somaGrupoLiquida * fatorDescFin) * (1 + taxaIva);

                return { 
                    ...g, 
                    itens: itensProcessados, 
                    totalDoGrupo: data.produtos.length > 1 ? fmt(somaGrupoComIva) : null 
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
