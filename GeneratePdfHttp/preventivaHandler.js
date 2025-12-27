"use strict";
const { normalizeList } = require("./sharedUtils");

module.exports = function(viewModel, data) {
    viewModel.maoObra = normalizeList(data.maoObra || data.maoDeObra);
    viewModel.material = normalizeList(data.material || data.materiais);
    viewModel.cliente = data.cliente || {};
    viewModel.relatorio = data.relatorio || {};
    return viewModel;
};
