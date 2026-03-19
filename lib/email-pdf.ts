function escapePdfText(input: string) {
  return input.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function htmlToPlainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|li|tr|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderTextToPdf(params: { title: string; lines: string[] }) {
  const wrapped = wrapLines(params.lines, 95);
  const linesPerPage = 42;
  const pages = [];

  for (let i = 0; i < wrapped.length; i += linesPerPage) {
    const pageLines = wrapped.slice(i, i + linesPerPage);
    const content = [
      "BT",
      "/F1 11 Tf",
      "50 780 Td",
      "14 TL",
      ...pageLines.map((line, index) => `${index === 0 ? "" : "T* " }(${escapePdfText(line)}) Tj`),
      "ET",
    ].join("\n");
    pages.push(content);
  }

  const objects: string[] = [];
  const addObject = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const fontObject = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageObjectIds: number[] = [];
  const contentObjectIds = pages.map((content) => addObject(`<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`));
  const pagesObjectId = objects.length + pages.length + 1;

  for (let i = 0; i < contentObjectIds.length; i += 1) {
    pageObjectIds.push(
      addObject(
        `<< /Type /Page /Parent ${pagesObjectId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObjectIds[i]} 0 R >>`,
      ),
    );
  }

  addObject(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`);
  const catalogObjectId = addObject(`<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjectId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

function wrapLines(lines: string[], maxChars: number) {
  const wrapped: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      wrapped.push("");
      continue;
    }

    let current = "";
    for (const word of line.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        wrapped.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) wrapped.push(current);
  }
  return wrapped.length > 0 ? wrapped : ["(empty email body)"];
}
