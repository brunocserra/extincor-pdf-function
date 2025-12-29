"use strict";
const { fmt } = require("./sharedUtils");

module.exports = function(viewModel, data) {
    // 1. Processamento do Cabeçalho (Header) 
    const h = data.header || {};
    
    // Valores Base
    const totalBrutoItens = parseFloat(h.totalBruto) || 0;
    const totalDescontosLinhas = parseFloat(h.totalDescontosItens) || 0;
    const percDescFinanceiro = parseFloat(h.descontoFinanceiroValor) || 0;
    const taxaIva = (parseFloat(h.taxaIva) || 0) / 100; // Ex: 0.16

    // Lógica de Totais
    const baseAposDescontosLinhas = totalBrutoItens - totalDescontosLinhas;
    const valorDescFin = baseAposDescontosLinhas * (percDescFinanceiro / 100);
    
    const totalLiq = baseAposDescontosLinhas - valorDescFin;
    const vIva = totalLiq * taxaIva;
    const totalFim = totalLiq + vIva;
    
    // Verificação de existência de descontos (de linha ou financeiros)
    const totalDescontosGeral = (totalBrutoItens - totalLiq);
    const temDescontos = totalDescontosGeral > 0.01; // Margem para erros de arredondamento

    viewModel.header = {
        ...h, 
        totalBruto: fmt(totalBrutoItens),
        temDescontos: temDescontos, // Usado no HTML para esconder/mostrar Bruto e Líquido
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
                    const qtd = parseFloat(i.qty) || 0;
                    const precoUnit = parseFloat(i.preco) || 0;
                    const totalLinha = parseFloat(i.total) || 0;
                    const descLinha = parseFloat(i.desconto) || 0;

                    // Somamos o total líquido da linha (já com desconto de linha se houver)
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
                        qty: qtd,
                        preco: fmt(precoUnit),
                        total: fmt(totalLinha),
                        desconto: descLinha > 0 ? fmt(descLinha) : null,
                        fotoUrl: nomeLocalFoto
                    };
                });

                // CÁLCULO DO GRUPO COM IVA:
                // Aplicamos o IVA e também o desconto financeiro proporcional ao grupo 
                // para que a soma dos subtotais bata certo com o Total Final.
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
