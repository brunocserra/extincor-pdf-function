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

    // Inicializar lista de URLs para a Azure Function descarregar [cite: 4]
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

                // Lógica de Imagem baseada no prod_id (ex: PRD-100044) [cite: 3, 5]
                let fotoUrl = null;
                const idOriginal = i.prod_id ? String(i.prod_id).trim() : "";
                
                if (idOriginal !== "" && idOriginal !== "0") {
                    // Criamos o URL absoluto para o Azure Blob Storage 
                    const urlAzure = `https://extincorpdfsstore.blob.core.windows.net/produtos/${idOriginal}.jpg`;
                    
                    // Adicionamos à lista que o GeneratePdfHttp.js vai usar para o axios.get [cite: 4]
                    listaParaDownload.push(urlAzure);
                    
                    // Definimos o URL para o HTML (O HTML usará o link direto do Azure) 
                    fotoUrl = urlAzure;
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
                totalDoGrupo: data.produtos.length > 1 ? fmt(somaGrupo) : null 
            };
        });
    } else {
        viewModel.produtos = [];
    }

    // 3. Importante: Injetar a lista de fotos no viewModel para o GeneratePdfHttp processar [cite: 4]
    // Isto garante que se o Gotenberg precisar de assets locais, a função os descarregue.
    viewModel.fotosRaw = listaParaDownload;

    viewModel.cliente = data.cliente || {};
    viewModel.reportId = data.reportId || "S/N";

    return viewModel;
};
