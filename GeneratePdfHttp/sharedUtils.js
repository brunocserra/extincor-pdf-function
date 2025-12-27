"use strict";

const fmt = (val) => {
    const num = parseFloat(val) || 0;
    return num.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function normalizeList(arrOrNull) {
    if (!arrOrNull) return [];
    const out = [];
    const pushSplit = (value) => {
        if (value == null) return;
        const str = String(value).trim();
        if (!str || str === "[object Object]") return;
        const parts = str.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
        for (const p of parts) out.push(p);
    };
    if (typeof arrOrNull === "string") {
        pushSplit(arrOrNull);
        return out;
    }
    if (Array.isArray(arrOrNull)) {
        for (const item of arrOrNull) {
            if (typeof item === "string") {
                pushSplit(item);
            } else if (item && typeof item === "object") {
                const val = item.Value ?? item.Result ?? item.Name ?? item.Label ?? "";
                pushSplit(val);
            }
        }
    }
    return out;
}

module.exports = { fmt, normalizeList };
