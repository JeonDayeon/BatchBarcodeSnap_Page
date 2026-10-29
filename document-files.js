// Document files are built locally. Photos and barcode values never leave the browser.
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const encoder = new TextEncoder();

function safeFilename(name) {
  return String(name || "바코드_문서").replace(/\.(xlsx|csv)$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160) || "바코드_문서";
}
function timestamp(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return "";
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function displayValue(value, ascii) {
  const text = String(value ?? "");
  return ascii ? text.replace(/[\u0000-\u001f\u007f]/g, c => `[ASCII ${c.charCodeAt(0)}]`) : text;
}
function orderedHits(photo, order) {
  const hits = [...(photo.hits || [])];
  return typeof order === "function" ? order(hits) : hits;
}
function decoded(hit) { return hit.recognized !== false && !hit.hasConflict && String(hit.value ?? "").length > 0; }
function documentTables(doc, options) {
  const unique = [], photos = [], barcodes = [], anchors = [], seen = new Set();
  for (const [photoIndex, photo] of (doc.photos || []).entries()) {
    const hits = orderedHits(photo, options.order);
    anchors.push({ photo, hits, row: photos.length + 1 });
    for (const [index, hit] of (hits.length ? hits : [null]).entries()) {
      const row = [String(doc.id || "").slice(0, 12), timestamp(photo.capturedAt || doc.createdAt), `${photoIndex + 1} / ${doc.photos.length}`, hit ? index + 1 : "", hit?.format || "", hit ? decoded(hit) ? displayValue(hit.value, options.ascii) : "읽지 못함" : "감지된 코드 없음", index === 0 ? "원본 사진" : "", index === 0 ? "인식 결과 사진" : "", photo.name || `사진 ${photoIndex + 1}`, hit?.left ?? "", hit?.top ?? "", hit?.right ?? "", hit?.bottom ?? "", hit ? JSON.stringify(String(hit.value ?? "")) : ""];
      photos.push(row);
      if (!hit || !decoded(hit)) continue;
      const entry = [doc.name || "작업", timestamp(photo.capturedAt || doc.createdAt), photoIndex + 1, index + 1, hit.format || "", displayValue(hit.value, options.ascii), JSON.stringify(String(hit.value ?? "")), hit.left ?? "", hit.top ?? "", hit.right ?? "", hit.bottom ?? ""];
      barcodes.push(entry);
      const key = `${hit.format}\u0000${hit.value}`;
      if (!seen.has(key)) { seen.add(key); unique.push(entry); }
    }
  }
  return { unique, photos, barcodes, anchors };
}

// Excel treats inline strings as text, preserving leading zeroes and preventing formulas.
// XML 1.0 cannot store most control characters; escape them visibly in export only.
function xml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, c => `[ASCII ${c.charCodeAt(0)}]`).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function column(index) { let text = ""; for (index++; index; index = Math.floor((index - 1) / 26)) text = String.fromCharCode(65 + (index - 1) % 26) + text; return text; }
function worksheet(headers, data, options = {}) {
  const rows = [headers, ...data];
  const tallRows = new Set((options.anchors || []).map(anchor => anchor.row + 1));
  const columns = headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 5 || i === headers.length - 1 ? 58 : i === 6 || i === 7 ? 25 : 20}" customWidth="1"/>`).join("");
  const content = rows.map((row, r) => `<row r="${r + 1}"${tallRows.has(r + 1) ? ' ht="118" customHeight="1"' : ""}>${row.map((cell, c) => `<c r="${column(c)}${r + 1}" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${content}</sheetData><autoFilter ref="A1:${column(headers.length - 1)}${rows.length}"/>${options.drawing ? '<drawing r:id="rId1"/>' : ""}</worksheet>`;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value; });
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;
}
function header(length, values) {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  for (const [offset, value, size] of values) size === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
  return bytes;
}
// A standard, uncompressed ZIP avoids requiring a network-loaded XLSX library.
function zip(entries) {
  const bodies = [], directory = []; let offset = 0, directoryLength = 0;
  for (const [path, value] of entries) {
    const name = encoder.encode(path), bytes = typeof value === "string" ? encoder.encode(value) : value;
    const crc = crc32(bytes), local = header(30, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x800, 2], [14, crc, 4], [18, bytes.length, 4], [22, bytes.length, 4], [26, name.length, 2]]);
    bodies.push(local, name, bytes);
    const central = header(46, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x800, 2], [16, crc, 4], [20, bytes.length, 4], [24, bytes.length, 4], [28, name.length, 2], [42, offset, 4]]);
    directory.push(central, name); directoryLength += central.length + name.length; offset += local.length + name.length + bytes.length;
  }
  return new Blob([...bodies, ...directory, header(22, [[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, directoryLength, 4], [16, offset, 4]])], { type: XLSX_TYPE });
}

async function photoImages(photo, hits) {
  if (!(photo.blob instanceof Blob)) throw new Error(`원본 사진을 찾지 못했습니다: ${photo.name || "사진"}`);
  let image, url;
  if (typeof createImageBitmap === "function") image = await createImageBitmap(photo.blob);
  else { url = URL.createObjectURL(photo.blob); image = new Image(); image.src = url; await image.decode(); }
  try {
    const width = image.width || image.naturalWidth, height = image.height || image.naturalHeight, scale = Math.min(1, 900 / Math.max(width, height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("사진을 내보낼 수 없습니다.");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const toBytes = async () => { const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .76)); if (!blob) throw new Error("사진 파일 생성 실패"); return new Uint8Array(await blob.arrayBuffer()); };
    const original = await toBytes(), sx = canvas.width / (photo.scanWidth || photo.width || width), sy = canvas.height / (photo.scanHeight || photo.height || height);
    ctx.lineWidth = 3; ctx.font = "bold 16px sans-serif";
    hits.forEach((hit, index) => {
      if (![hit.left, hit.top, hit.right, hit.bottom].every(Number.isFinite)) return;
      const left = Math.max(0, hit.left * sx), top = Math.max(0, hit.top * sy), w = Math.max(12, (hit.right - hit.left) * sx), h = Math.max(12, (hit.bottom - hit.top) * sy);
      ctx.strokeStyle = ctx.fillStyle = decoded(hit) ? "#16a34a" : "#d97706"; ctx.strokeRect(left, top, w, h);
      const label = `${index + 1} ${decoded(hit) ? "✓" : "?"}`, bw = ctx.measureText(label).width + 12, by = Math.max(0, top - 24), bx = Math.min(left, Math.max(0, canvas.width - bw));
      ctx.fillRect(bx, by, bw, 24); ctx.fillStyle = "white"; ctx.fillText(label, bx + 6, by + 18);
    });
    return { original, result: await toBytes(), width: canvas.width, height: canvas.height };
  } finally { image.close?.(); if (url) URL.revokeObjectURL(url); }
}

function drawing(images) {
  const content = images.map((image, index) => {
    const columnNumber = 6 + index % 2, maxWidth = 1650000, maxHeight = 1440000, ratio = image.width / image.height;
    let width = maxWidth, height = width / ratio; if (height > maxHeight) { height = maxHeight; width = height * ratio; }
    return `<xdr:oneCellAnchor><xdr:from><xdr:col>${columnNumber}</xdr:col><xdr:colOff>40000</xdr:colOff><xdr:row>${image.row}</xdr:row><xdr:rowOff>40000</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(width)}" cy="${Math.round(height)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="사진 ${Math.floor(index / 2) + 1} ${index % 2 ? "인식 결과" : "원본"}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${index + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${content}</xdr:wsDr>`;
}
function relationships(entries) { return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`; }

/** Builds a genuine file for downloads, external opening or file sharing. Does not save or mutate the document. */
export async function buildDocumentFile(doc, options = {}) {
  const docs = Array.isArray(doc) ? doc : [doc];
  if (!docs.length || docs.some(item => !item || !Array.isArray(item.photos))) throw new Error("내보낼 문서를 찾지 못했습니다.");
  const format = options.format || docs[0].format || "xlsx", tables = { unique: [], photos: [], barcodes: [], anchors: [] }, filename = safeFilename(options.name || (docs.length > 1 ? "선택한_문서" : docs[0].name));
  for (const item of docs) {
    const next = documentTables(item, options), offset = tables.photos.length;
    tables.anchors.push(...next.anchors.map(anchor => ({ ...anchor, row: anchor.row + offset })));
    tables.unique.push(...next.unique); tables.photos.push(...next.photos); tables.barcodes.push(...next.barcodes);
  }
  if (format === "csv") {
    const headers = ["문서", "촬영일시", "사진번호", "사진 내 순번", "바코드형식", "바코드값", "원본 값(JSON)", "왼쪽", "위", "오른쪽", "아래"];
    // CSV has no text cell type. Prefix formula-like or numeric strings with an apostrophe;
    // the JSON column retains the original barcode exactly for lossless re-import.
    const cell = value => { let text = String(value ?? ""); if (/^[\s]*[=+\-@]/.test(text) || /^\s*\d/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text; return `"${text.replaceAll('"', '""')}"`; };
    return new File(["\ufeff", [headers, ...tables.unique].map(row => row.map(cell).join(",")).join("\r\n")], `${filename}.csv`, { type: "text/csv;charset=utf-8" });
  }
  if (format !== "xlsx") throw new Error("지원하지 않는 저장 형식입니다.");
  const imageEntries = [], images = [];
  for (const anchor of tables.anchors) {
    const pair = await photoImages(anchor.photo, anchor.hits);
    for (const bytes of [pair.original, pair.result]) { imageEntries.push([`xl/media/image${images.length + 1}.jpg`, bytes]); images.push({ row: anchor.row, width: pair.width, height: pair.height }); }
  }
  const common = ["문서", "촬영 일시", "사진 번호", "사진 내 순번", "바코드 형식", "바코드 값", "원본 값(JSON)", "왼쪽", "위", "오른쪽", "아래"];
  const sheetNames = ["고유 바코드", "사진별 기록", "바코드별 기록"];
  const sheetOverrides = sheetNames.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const drawingOverrides = images.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : "";
  const entries = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}${drawingOverrides}</Types>`],
    ["_rels/.rels", relationships([["rId1", "officeDocument", "xl/workbook.xml"]])],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetNames.map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", relationships([...sheetNames.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]), ["rId4", "styles", "styles.xml"]])],
    ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ["xl/worksheets/sheet1.xml", worksheet(common, tables.unique)],
    ["xl/worksheets/sheet2.xml", worksheet(["기록 번호", "촬영 일시", "사진 번호", "사진 내 순번", "바코드 종류", "바코드 값", "원본 사진", "인식 결과 사진", "사진 파일명", "왼쪽", "위", "오른쪽", "아래", "원본 값(JSON)"], tables.photos, { anchors: tables.anchors, drawing: images.length > 0 })],
    ["xl/worksheets/sheet3.xml", worksheet(common, tables.barcodes)],
    ...imageEntries
  ];
  if (images.length) entries.push(["xl/worksheets/_rels/sheet2.xml.rels", relationships([["rId1", "drawing", "../drawings/drawing1.xml"]])], ["xl/drawings/drawing1.xml", drawing(images)], ["xl/drawings/_rels/drawing1.xml.rels", relationships(images.map((_, i) => [`rId${i + 1}`, "image", `../media/image${i + 1}.jpg`]))]);
  return new File([zip(entries)], `${filename}.xlsx`, { type: XLSX_TYPE });
}

export function downloadDocumentFile(file) {
  const url = URL.createObjectURL(file), link = document.createElement("a"); link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
export async function shareDocumentFiles(files) {
  if (!files?.length) throw new Error("공유할 파일을 선택하세요.");
  if (navigator.share && navigator.canShare?.({ files })) { await navigator.share({ files, title: "BatchBarcode Snap" }); return "shared"; }
  files.forEach(downloadDocumentFile); return "downloaded";
}
export function openDocumentFile(file) {
  // iOS can preview these files, while other browsers hand them to Downloads or Excel.
  const url = URL.createObjectURL(file), tab = window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 120000);
  return tab ? "opened" : downloadDocumentFile(file);
}
