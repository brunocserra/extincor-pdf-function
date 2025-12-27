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
    
    // Cálculo do valor do IVA (Total Final - (Total Líquido - Desconto Financeiro))
    // Usamos Math.max(0, ...) para evitar valores negativos por erros de arredondamento
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

    // 2. Processamento dos Grupos e Produtos
    if (data.produtos && Array.isArray(data.produtos)) {
        viewModel.produtos = data.produtos.map(g => {
            let somaGrupo = 0;

            // Mapeamento dos itens dentro de cada grupo
            const itensProcessados = (g.itens || []).map(i => {
                const qtd = parseFloat(i.qty) || 0;
                const precoUnit = parseFloat(i.preco) || 0;
                const totalLinha = parseFloat(i.total) || 0;
                const descLinha = parseFloat(i.desconto) || 0;

                somaGrupo += totalLinha;

                // Construção do URL da Imagem (Azure Blob Storage)
                // Verifica se o prod_id existe e não é "0" ou vazio
                let fotoUrl = null;
                const idLimpo = i.prod_id ? String(i.prod_id).trim() : "";
                
                if (idLimpo !== "" && idLimpo !== "0") {
                    // O nome do ficheiro no Azure deve ser [ID_DO_PRODUTO].jpg
                    fotoUrl = `https://extincorpdfsstore.blob.core.windows.net/produtos/${idLimpo}.jpg`;
                }

                return { 
                    ...i, 
                    qty: qtd,
                    preco: fmt(precoUnit), 
                    total: fmt(totalLinha), 
                    desconto: descLinha > 0 ? fmt(descLinha) : null,
                    fotoUrl: fotoUrl
                };
            });

            return { 
                ...g, 
                itens: itensProcessados, 
                // Só mostra o total da secção se existir mais do que um grupo no orçamento
                totalDoGrupo: data.produtos.length > 1 ? fmt(somaGrupo) : null 
            };
        });
    } else {
        // Fallback caso a lista de produtos venha vazia ou mal formatada
        viewModel.produtos = [];
    }

    // 3. Informações de Cliente (Passagem direta)
    viewModel.cliente = data.cliente || {};

    // 4. Metadados do Relatório
    viewModel.reportId = data.reportId || "S/N";

    return viewModel;
};
