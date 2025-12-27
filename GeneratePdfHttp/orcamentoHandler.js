"use strict";
const { fmt } = require("./sharedUtils");

module.exports = function(viewModel, data) {
    const h = data.header || {};
    const totalLiq = parseFloat(h.totalLiquido) || 0;
    const totalFim = parseFloat(h.totalFinal) || 0;
    const descFin = parseFloat(h.descontoFinanceiroValor) || 0;
    const vIva = Math.max(0, totalFim - totalLiq + descFin);

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

    if (Array.isArray(data.produtos)) {
        viewModel.produtos = data.produtos.map(g => {
            let somaG = 0;
            const itns = (g.itens || []).map(i => {
                const t = parseFloat(i.total) || 0;
                const d = parseFloat(i.desconto) || 0;
                somaG += t;

                // LÓGICA DA IMAGEM: Construir link apenas se houver prod_id
                let fotoUrl = null;
                if (i.prod_id && i.prod_id.trim() !== "" && i.prod_id !== "0") {
                    fotoUrl = `https://extincorpdfsstore.blob.core.windows.net/produtos/${i.prod_id}.jpg`;
                }

                return { 
                    ...i, 
                    preco: fmt(i.preco), 
                    total: fmt(t), 
                    desconto: d > 0 ? fmt(d) : null,
                    fotoUrl: fotoUrl
                };
            });
            return { 
                ...g, 
                itens: itns, 
                totalDoGrupo: data.produtos.length > 1 ? fmt(somaG) : null 
            };
        });
    }
    return viewModel;
};
